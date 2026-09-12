import { SendError } from "../whatsapp/sender";
import type { MessageJob, MessageSender, MessagingRepository, ReplyStrategy } from "./types";

/** Reusable orchestration; no Next.js, Supabase SDK, or AI provider dependency. */
export async function processIncomingMessage(job: MessageJob, deps: {
  repository: MessagingRepository; sender: MessageSender; strategy: ReplyStrategy;
}): Promise<"sent" | "skipped" | "failed" | "needs_review"> {
  const { repository, sender, strategy } = deps;
  // Errors before prepare leave a recoverable processing lease; no external send occurred.
  const context = await repository.context(job);
  const text = await strategy.reply(context);
  const reply = await repository.prepare(job, text);
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
export async function drainMessages(deps: Parameters<typeof processIncomingMessage>[1], limit = 3) {
  const results: string[] = [];
  for (let i = 0; i < limit; i++) {
    const job = await deps.repository.claim();
    if (!job) break;
    results.push(await processIncomingMessage(job, deps));
  }
  return results;
}
