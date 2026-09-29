import { SendError } from "../whatsapp/sender";
import type { MessageJob, MessageSender, MessagingRepository, ReplyStrategy } from "./types";

/** Reusable orchestration; no Next.js, Supabase SDK, or AI provider dependency. */
export async function processIncomingMessage(job: MessageJob, deps: {
  moderator?: import('../moderation/provider').ContentModerator;
  repository: MessagingRepository; sender: MessageSender; strategy: ReplyStrategy;
}): Promise<"sent" | "skipped" | "failed" | "needs_review"> {
  const { repository, sender, strategy } = deps;
  // Errors before prepare leave a recoverable processing lease; no external send occurred.
  const context = await repository.context(job);
  if(deps.moderator){
    if(!repository.moderate)throw new Error('Moderation persistence unavailable');
    // Recovered jobs reuse the durable verdict. Blocked customers never invoke the AI.
    const result=context.blocked?{state:'clear' as const,categories:[]}:context.moderationState==='clear'?{state:'clear' as const,categories:[]}:await deps.moderator.check(context);
    if(!await repository.moderate(job,result))return 'skipped';
  }
  const decision = await strategy.reply({ ...context, requestKey: `message:${job.inbound_message_id}` });
  if (typeof decision !== 'string' && !repository.prepareDecision) throw new Error('Structured reply persistence unavailable');
  const reply = typeof decision === 'string' ? await repository.prepare(job, decision) : await repository.prepareDecision!(job, decision);
  if (!reply) return "skipped";
  // prepare durably records 'sending' before the external side effect.
  try {
    const providerId = await sender.send(reply);
    await repository.complete(job, providerId);
    return "sent";
  } catch (error) {
    const state = error instanceof SendError && !error.ambiguous ? "failed" : "needs_review";
    await repository.fail(job, state, error instanceof SendError ? error.code : "send_or_commit_unknown");
    return state;
  }
}
export async function drainMessages(deps: Parameters<typeof processIncomingMessage>[1], limit = 3, claimWindowMs = 5_000) {
  const results: string[] = [];
  const started=Date.now();
  for (let i = 0; i < limit; i++) {
    // Retry immediate pre-send failures in this invocation, but never start
    // another potentially slow model request after the bounded claim window.
    if(i>0&&Date.now()-started>=claimWindowMs)break;
    const job = await deps.repository.claim();
    if (!job) break;
    try{results.push(await processIncomingMessage(job, deps));}
    catch{
      if(!deps.repository.recover)throw new Error('Processing recovery unavailable');
      results.push(`recovered:${await deps.repository.recover(job,'processing_error')}`);
    }
  }
  return results;
}
