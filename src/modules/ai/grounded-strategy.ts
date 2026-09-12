import { replyLanguage } from './language';
import type { MessageContext, ReplyStrategy } from '../messaging/types';
import type { AgentDecision, KnowledgeSource } from './contracts';
import type { UsageLedger } from './ledger';
import { AI_MODEL, MAX_KNOWLEDGE_BYTES } from './config';
import { buildRequest, ModelFailure, type ModelProvider } from './openai';
export type SourceLoader = (tenant: string) => Promise<KnowledgeSource[]>;
export function fallback(context: MessageContext, reason: string, action: AgentDecision['action'] = 'unavailable'): AgentDecision {
  const ar = replyLanguage(context.text ?? '') === 'ar';
  const text = action === 'handoff'
    ? ar ? 'طلبك محتاج مساعدة من فريق العمل. من فضلك تواصل مع الفريق مباشرة؛ الردود الآلية هتتوقف في المحادثة دي.' : 'Please contact the business team directly for help. Automated replies will pause in this conversation.'
    : ar ? 'المعلومة دي مش متاحة عندي بشكل مؤكد حالياً. من فضلك وضّح سؤالك أو تواصل مع فريق العمل مباشرة.' : 'I do not have confirmed information for this right now. Please clarify your question or contact the business team directly.';
  return { text, action, reason, sources: [] };
}
function sourcesCurrent(decision: AgentDecision, available: KnowledgeSource[]) {
  return decision.sources.every(s => available.some(a => a.id === s.id && a.kind === s.kind && a.updatedAt === s.updatedAt));
}
export class GroundedStrategy implements ReplyStrategy {
  constructor(private loadSources: SourceLoader, private ledger: UsageLedger, private provider: ModelProvider,
    private purpose: 'whatsapp'|'acceptance' = 'whatsapp') {}
  async reply(context: MessageContext): Promise<AgentDecision> {
    if (context.eligible === false) return fallback(context, 'ineligible', 'suppress');
    if (context.type !== 'text' || !context.text?.trim()) return fallback(context, 'unsupported_message');
    if (/\b(speak|talk|connect|transfer).{0,35}\b(human|person|agent|staff)\b|\b(human|real person)\b|(?:عايز|عاوز|ممكن|أريد|اريد).{0,30}(?:موظف|بني آدم|بني ادم|حد من|خدمة العملاء)|(?:كلمني|وصلني).{0,20}(?:موظف|حد)/i.test(context.text))
      return fallback(context, 'human_requested', 'handoff');
    if (!context.requestKey) return fallback(context, 'missing_request_identity');
    if (Buffer.byteLength(context.text, 'utf8') > 3500) return fallback(context, 'message_too_long');
    let sources: KnowledgeSource[];
    try { sources = await this.loadSources(context.tenantId); }
    catch { return fallback(context, 'knowledge_unavailable'); }
    if (!sources.length) return fallback(context, 'no_approved_knowledge');
    if (sources.length > 40 || Buffer.byteLength(JSON.stringify(sources.map(s => ({ label: s.label, content: s.content }))), 'utf8') > MAX_KNOWLEDGE_BYTES)
      return fallback(context, 'knowledge_too_large');
    let request: string;
    try { request = buildRequest(context, sources); } catch { return fallback(context, 'context_too_large'); }
    // Reservation commits before the external API call. No auto-retry of a reserved request.
    const reservation = await this.ledger.reserve(context.tenantId, context.requestKey, this.purpose);
    if (reservation.status === 'completed') {
      const decision = reservation.decision;
      if (!decision || !Array.isArray(decision.sources) || !sourcesCurrent(decision, sources)) return fallback(context, 'cached_knowledge_changed');
      return decision;
    }
    if (reservation.status !== 'new' || !reservation.id) return fallback(context, `ai_${reservation.status}`);
    const start = Date.now();
    let result: Awaited<ReturnType<ModelProvider['complete']>>;
    try { result = await this.provider.complete(request); }
    catch (error) {
      const known = error instanceof ModelFailure ? error : new ModelFailure('openai_unknown_failure');
      await this.ledger.finish(context.tenantId, reservation.id, { state: 'failed', input: known.usage?.input ?? null,
        output: known.usage?.output ?? null, latency: Date.now()-start, decision: null, error: known.code });
      return fallback(context, known.code);
    }
    const selected = [...new Set(result.decision.sourceLabels)].map(label => sources.find(s => s.label === label));
    const invalidSources = selected.some(s => !s) || (result.decision.action === 'answer' && !selected.length);
    let decision: AgentDecision;
    if (invalidSources) decision = fallback(context, 'invalid_source_reference');
    else if (result.decision.action === 'unavailable' || result.decision.action === 'handoff')
      decision = fallback(context, result.decision.action === 'handoff' ? 'human_requested' : 'answer_not_supported', result.decision.action);
    else decision = { text: result.decision.text, action: result.decision.action, reason: 'approved_knowledge',
      sources: selected.map(s => ({ id: s!.id, kind: s!.kind, updatedAt: s!.updatedAt })) };
    // Never let the model invent a link, even when it names a valid source.
    const urls = decision.text.match(/https?:\/\/[^\s<>]+/g) ?? [];
    if (urls.some(url => !selected.some(s => s?.content.includes(url)))) decision = fallback(context, 'unsupported_link');
    if (replyLanguage(decision.text) !== replyLanguage(context.text)) decision = fallback(context, 'wrong_response_language');
    decision.usage = { model: AI_MODEL, inputTokens: result.input, outputTokens: result.output, costNano: result.input*400+result.output*1600 };
    await this.ledger.finish(context.tenantId, reservation.id, { state: 'completed', input: result.input,
      output: result.output, latency: Date.now()-start, decision, error: null });
    return decision;
  }
}
