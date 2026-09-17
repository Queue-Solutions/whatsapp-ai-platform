import { detectAttention, summarizeAttention } from './attention-detection';
import { replyLanguage } from './language';
import { socialReply } from './social-reply';
import type { MessageContext, ReplyStrategy } from '../messaging/types';
import type { AgentDecision, KnowledgeSource } from './contracts';
import type { UsageLedger } from './ledger';
import { AI_MODEL } from './config';
import { selectKnowledge } from './knowledge-selection';
import { knowledgeGap } from './knowledge-gap';
import { beginFollowUp, continueFollowUp } from './follow-up';
import { formatReply, formatBranchReply } from './reply-format';
import { buildRequest, ModelFailure, type ModelProvider } from './openai';
export type SourceLoader = (tenant: string) => Promise<KnowledgeSource[]>;
export function fallback(context: MessageContext, reason: string, action: AgentDecision['action'] = 'unavailable'): AgentDecision {
  const ar = replyLanguage(context.text ?? '') === 'ar';
  const technical = /^(knowledge_unavailable|knowledge_selection_empty|context_too_large|missing_request_identity|cached_knowledge_changed|invalid_source_reference|unsupported_link|wrong_response_language|openai_|ai_)/.test(reason);
  const text = action === 'handoff'
    ? ar ? 'طلبك محتاج متابعة شخصية من صاحب النشاط. هوقف الردود الآلية هنا علشان يقدر يراجع المحادثة ويرد عليك.' : 'Your message needs personal attention from the business owner. I’ll pause automated replies here so they can review the conversation and respond.'
    : technical
      ? ar ? 'آسف، مش قادر أجاوبك دلوقتي بسبب مشكلة تقنية. حاول تاني بعد شوية، أو اطلب تتكلم مع صاحب النشاط.' : 'Sorry, I can’t answer right now because of a technical issue. Please try again later, or ask to speak to the business owner.'
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
    const decision=await this.generate(context);
    const followUp=decision.followUp?decision:decision.action==='handoff'||decision.reason==='missing_business_information'
      ? beginFollowUp(context,decision):decision;
    return {...followUp,text:formatReply(followUp.text,replyLanguage(context.text??'')==='ar'),
      ...(followUp.attentionSummary?{attentionSummary:formatReply(followUp.attentionSummary,replyLanguage(context.text??'')==='ar')}: {})};
  }
  private async generate(context: MessageContext): Promise<AgentDecision> {
    if (context.eligible === false) return fallback(context, 'ineligible', 'suppress');
    const contactReply=continueFollowUp(context);
    if(contactReply)return contactReply;
    if (context.type !== 'text' || !context.text?.trim()) return fallback(context, 'unsupported_message');
    const attention = detectAttention(context.text);
    if (attention) return { ...fallback(context, attention, 'handoff'), attentionSummary: summarizeAttention(context.text,attention) };
    if (!context.requestKey) return fallback(context, 'missing_request_identity');
    if (Buffer.byteLength(context.text, 'utf8') > 3500) return fallback(context, 'message_too_long');
    const social = socialReply(context.text);
    if (social) return social;
    let sources: KnowledgeSource[];
    try { sources = await this.loadSources(context.tenantId); }
    catch { return fallback(context, 'knowledge_unavailable'); }
    if (!sources.length) return knowledgeGap(context, replyLanguage(context.text) === 'ar'
      ? 'لا توجد معلومات معتمدة منشورة للمساعد. راجع سؤال العميل وأضف المعلومات المطلوبة.'
      : 'No approved business information is published for the assistant. Review the customer’s question and add the required information.');
    const available = sources;
    const selection = selectKnowledge(context, available);
    sources = selection.sources;
    if (!sources.length) return fallback(context, 'knowledge_selection_empty');
    let request: string;
    try { request = buildRequest(context, sources, selection.coverage); } catch { return fallback(context, 'context_too_large'); }
    // Reservation commits before the external API call. No auto-retry of a reserved request.
    const reservation = await this.ledger.reserve(context.tenantId, context.requestKey, this.purpose);
    if (reservation.status === 'completed') {
      const decision = reservation.decision;
      if (!decision || !Array.isArray(decision.sources) || !sourcesCurrent(decision, available)) return fallback(context, 'cached_knowledge_changed');
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
    else if (result.decision.action === 'knowledge_gap') {
      decision = result.decision.sourceLabels.length ? fallback(context, 'invalid_source_reference')
        : knowledgeGap(context, result.decision.summary, selection.coverage.omittedSourceCount > 0);
    }
    else if (result.decision.action === 'unavailable' || result.decision.action === 'handoff' || result.decision.action === 'complaint')
      decision = fallback(context, result.decision.action === 'complaint' ? 'complaint' : result.decision.action === 'handoff' ? 'human_requested' : 'answer_not_supported', result.decision.action === 'complaint' ? 'handoff' : result.decision.action);
    else decision = { text: formatReply(formatBranchReply(result.decision.text,result.decision.branchLines),replyLanguage(context.text)==='ar'), action: result.decision.action, reason: 'approved_knowledge',
      sources: selected.map(s => ({ id: s!.id, kind: s!.kind, updatedAt: s!.updatedAt })) };
    if (decision.action === 'handoff' && result.decision.summary?.trim()) decision.attentionSummary = result.decision.summary.trim();
    // Never let the model invent a link, even when it names a valid source.
    const urls = decision.text.match(/https?:\/\/[^\s<>]+/g) ?? [];
    if (urls.some(url => !selected.some(s => s && (s.content.includes(url) || s.content.includes(url.replace(/%3B/gi,';').replace(/%D8%9B/gi,'؛')))))) decision = fallback(context, 'unsupported_link');
    if (decision.text.length>4096) decision=fallback(context,'context_too_large');
    if (replyLanguage(decision.text) !== replyLanguage(context.text)) decision = fallback(context, 'wrong_response_language');
    decision.usage = { model: AI_MODEL, inputTokens: result.input, outputTokens: result.output, costNano: result.input*400+result.output*1600 };
    await this.ledger.finish(context.tenantId, reservation.id, { state: 'completed', input: result.input,
      output: result.output, latency: Date.now()-start, decision, error: null });
    return decision;
  }
}
