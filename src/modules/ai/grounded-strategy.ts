import {nearestBranchReply} from './nearest-branch';
import {GeoLocations,type LocationResolver} from './branch-location';
import {btcBranchReply} from './btc-branches';
import {technicalFailure,recoverableFailure} from './recovery';
import {hasUnsupportedLink,offeredLinks} from './approved-links';
import {needsProductQuestion,productQuestion,renderBranchAnswer,directBranchDetail,directJewelryDirectory,productIntent,bullionPattern} from './branch-dialogue';
import {resolveContinuation,isProductChoiceContinuation,isShortAcceptance} from './conversation-context';
import {unsolicitedBranches,scopeClarification,branchScope,normalizeIntent,matchingBranches} from './branch-scope';
import { detectAttention, summarizeAttention } from './attention-detection';
import { replyLanguage } from './language';
import { socialReply } from './social-reply';
import type { MessageContext, ReplyStrategy } from '../messaging/types';
import type { AgentDecision, KnowledgeSource } from './contracts';
import type { UsageLedger } from './ledger';
import { AI_MODEL } from './config';
import { selectKnowledge, selectReturnsKnowledge } from './knowledge-selection';
import { knowledgeGap } from './knowledge-gap';
import { assistantResumedReply, beginFollowUp, continueFollowUp, isCareerEnquiry, repeatFollowUp } from './follow-up';
import {careerFaqReply} from './career-faq';
import {repairFaqReply} from './repair-faq';
import { formatReply, formatBusinessReply, formatBranchReply } from './reply-format';
import { buildRequest, ModelFailure, type ModelProvider } from './openai';
import {buildIntentRequest,catalogFingerprint,contextForIntent,isStoredIntentDecision,type IntentDecision,type StoredIntentDecision} from './intent-classification';
export type SourceLoader = (tenant: string) => Promise<KnowledgeSource[]>;
export function fallback(context: MessageContext, reason: string, action: AgentDecision['action'] = 'unavailable'): AgentDecision {
  const ar = replyLanguage(context.text ?? '') === 'ar';
  if(technicalFailure(reason))return {text:'',action:'suppress',reason,sources:[]};
  const text = action === 'handoff'
    ? ar ? 'يتطلب طلبك متابعة شخصية من فريق IRAM. سيتم إيقاف الردود الآلية لهذه المحادثة حتى يتمكن الفريق من مراجعتها والرد عليك.' : 'Your request requires personal attention from the IRAM team. Automated replies will be paused while the team reviews the conversation and responds.'
    : reason === 'answer_not_supported'
      ? ar ? 'أنا هنا لمساعدتك في كل ما يخص مجوهرات IRAM ومنتجات BTC والسبائك وخدماتنا. كيف يمكنني مساعدتك في تجربتك مع IRAM؟' : 'I’m here to assist with IRAM jewelry, BTC / bullion products and our services. How may I support your IRAM experience?'
      : ar ? 'هذه المعلومة غير متاحة لدي بشكل مؤكد حاليًا. يرجى توضيح استفسارك أو التواصل مع فريق IRAM مباشرة.' : 'I don’t currently have confirmed information for this request. Please clarify your enquiry or contact the IRAM team directly.';
  return { text, action, reason, sources: [] };
}
function sourcesCurrent(decision: AgentDecision, available: KnowledgeSource[]) {
  return decision.sources.every(s => available.some(a => a.id === s.id && a.kind === s.kind && a.updatedAt === s.updatedAt));
}
function isAgentDecision(value:unknown):value is AgentDecision {
  if(!value||typeof value!=='object')return false;
  const decision=value as Partial<AgentDecision>;
  return typeof decision.text==='string'&&typeof decision.action==='string'&&typeof decision.reason==='string'&&Array.isArray(decision.sources);
}
const defaultLocations=new GeoLocations();
export const AI_RETRY_DELAY_MS=4000;
const defaultRetryDelay=(milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds));
export class GroundedStrategy implements ReplyStrategy {
  constructor(private loadSources: SourceLoader, private ledger: UsageLedger, private provider: ModelProvider,
    private purpose: 'whatsapp'|'acceptance' = 'whatsapp', private locations:LocationResolver=defaultLocations,
    private retryDelay:(milliseconds:number)=>Promise<void>=defaultRetryDelay) {}
  async reply(context: MessageContext): Promise<AgentDecision> {
    const resolved=resolveContinuation(context);
    let decision=await this.generate(resolved);
    for(let attempt=1;attempt<=2&&context.requestKey&&context.eligible!==false&&recoverableFailure(decision.reason);attempt++){
      await this.retryDelay(AI_RETRY_DELAY_MS);
      decision=await this.generate(resolved,decision.reason,attempt);
    }
    // Includes cached decisions from older deployments: never return their technical-error prose.
    if(technicalFailure(decision.reason))return {...decision,text:'',action:'suppress',sources:[]};
    const followUp=decision.followUp?decision:decision.action==='handoff'||decision.reason==='missing_business_information'
      ? beginFollowUp(context,decision):decision;
    return {...followUp,text:followUp.reason.startsWith('social_')?formatReply(followUp.text):formatBusinessReply(followUp.text),
      ...(followUp.attentionSummary?{attentionSummary:formatReply(followUp.attentionSummary)}: {})};
  }
  private async classifyIntent(context:MessageContext,sources:KnowledgeSource[]):Promise<IntentDecision|null>{
    if(!this.provider.classifyIntent||!context.requestKey)return null;
    const fingerprint=catalogFingerprint(sources);
    let request:string;
    try{request=buildIntentRequest(context,sources);}catch{return null;}
    const key=`${context.requestKey.slice(0,160)}:intent:${fingerprint}`;
    const reservation=await this.ledger.reserve(context.tenantId,key,this.purpose);
    if(reservation.status==='completed')return isStoredIntentDecision(reservation.decision,fingerprint)?reservation.decision:null;
    if(reservation.status!=='new'||!reservation.id)return null;
    const start=Date.now();
    try{
      const result=await this.provider.classifyIntent(request,{timeoutMs:10000});
      const allowed=new Set(sources.map(source=>source.label));
      if(result.decision.branchLabels.some(label=>!allowed.has(label)))throw new ModelFailure('openai_invalid_intent',result);
      const stored:StoredIntentDecision={kind:'intent_classification',catalogFingerprint:fingerprint,...result.decision};
      await this.ledger.finish(context.tenantId,reservation.id,{state:'completed',input:result.input,output:result.output,
        latency:Date.now()-start,decision:stored,error:null});
      return stored;
    }catch(error){
      const known=error instanceof ModelFailure?error:new ModelFailure('openai_intent_unknown');
      await this.ledger.finish(context.tenantId,reservation.id,{state:'failed',input:known.usage?.input??null,output:known.usage?.output??null,
        latency:Date.now()-start,decision:null,error:known.code});
      return null;
    }
  }
  private async generate(context: MessageContext, recoveryReason?:string, recoveryAttempt=0): Promise<AgentDecision> {
    if (context.eligible === false) return fallback(context, 'ineligible', 'suppress');
    if(context.resumeRequested)return assistantResumedReply(context);
    const careerIntent=isCareerEnquiry(context.text??'');
    // Career collection was retired: ignore any legacy in-progress career form and answer from the approved FAQ instead.
    // A new hiring/HR question also exits any unrelated contact-collection flow.
    const contactReply=context.followUp?.purpose==='career'||careerIntent?null:continueFollowUp(context);
    // A completed contact form is deterministic and must not go back through intent
    // classification, which can discard the fields and restart the form. An
    // unlabelled name by itself is held briefly so approved branch names can still
    // take precedence below (for example, "Alexandria").
    const inferredName=contactReply?.followUp?.name&&!context.followUp?.name&&!/(?:my name is|name\s*:|اسمي|إسمي|الاسم\s*:)/i.test(context.text??'');
    if(contactReply&&(!inferredName||contactReply.followUp?.phone))return contactReply;
    if (!['text','location'].includes(context.type) || !context.text?.trim()) return fallback(context, 'unsupported_message');
    if (!context.requestKey) return fallback(context, 'missing_request_identity');
    if (Buffer.byteLength(context.text, 'utf8') > 3500) return fallback(context, 'message_too_long');
    // Exact standalone greetings and thanks describe the latest turn completely.
    // Resolve them before classification so stale issue history (or a cached
    // classifier result) can never reopen a completed personal follow-up.
    const social=socialReply(context.text,context.history);if(social)return social;
    let sources:KnowledgeSource[]=[],knowledgeUnavailable=false;
    try { sources = await this.loadSources(context.tenantId); }
    catch { knowledgeUnavailable=true; }
    // Combined details and labelled fields are deterministic. A bare one-word
    // name is intentionally held for semantic validation below so an
    // acknowledgement cannot silently become customer data. If classification
    // is unavailable, retain the safe legacy fallback after excluding branches.
    if(contactReply&&inferredName&&!this.provider.classifyIntent&&(knowledgeUnavailable||!matchingBranches(context.text??'',sources).length))return contactReply;
    // Employment and HR requests use the approved hiring FAQ. They must win over
    // generic phrases such as "reach the HR department", which also resemble a
    // request for a person and previously opened an unnecessary follow-up.
    if(careerIntent){
      if(knowledgeUnavailable)return fallback(context,'knowledge_unavailable');
      return careerFaqReply(context,sources,true)??fallback(context,'career_information_unavailable');
    }
    if(!this.provider.classifyIntent){
      const attention=detectAttention(context.text);
      if(attention)return {...fallback(context,attention,'handoff'),attentionSummary:summarizeAttention(context.text,attention)};
    }
    // A product choice answering our own branch-routing question is deterministic context, not a new support intent.
    if(!knowledgeUnavailable&&isProductChoiceContinuation(context)){
      const branchDetail=directBranchDetail(context,sources);if(branchDetail)return branchDetail;
      const branchDirectory=directJewelryDirectory(context,sources);if(branchDirectory)return branchDirectory;
    }
    const classified=await this.classifyIntent(context,sources);
    const useClassification=classified&&classified.confidence>=0.6?classified:null;
    const routed=useClassification?contextForIntent(context,useClassification,sources):context;
    if(contactReply&&inferredName){
      if(useClassification?.intent==='contact_details')return contactReply;
      if(!useClassification&&(knowledgeUnavailable||!matchingBranches(context.text??'',sources).length))return contactReply;
      // Acknowledgements are filtered before the classifier. This guard covers
      // other non-detail replies without saving them as a name or losing the
      // active form state.
      if(useClassification&&['greeting','thanks','unrelated','ambiguous'].includes(useClassification.intent))return repeatFollowUp(context)??contactReply;
    }
    if(useClassification?.intent==='career'){
      if(knowledgeUnavailable)return fallback(context,'knowledge_unavailable');
      return careerFaqReply(context,sources,true)??fallback(context,'career_information_unavailable');
    }
    if(useClassification?.intent==='human_followup'||useClassification?.intent==='complaint'){
      const reason=useClassification.intent==='complaint'?'complaint':'human_requested';
      return {...fallback(context,reason,'handoff'),attentionSummary:useClassification.summary||summarizeAttention(context.text,reason)};
    }
    if(useClassification?.intent==='greeting'||useClassification?.intent==='thanks'){
      return socialReply(useClassification.normalizedQuery,context.history,useClassification.intent)!;
    }
    if(useClassification?.intent==='unrelated')return fallback(context,'answer_not_supported');
    // Ambiguity from the compact classifier is advisory, not a terminal answer.
    // Let the grounded answer model review the request alongside relevant approved
    // knowledge. It can still ask one clarification when the request is genuinely
    // unclear, while broad but valid questions are no longer blocked from their FAQ.
    if(useClassification?.intent==='branch'&&useClassification.branchMode==='detail'&&!useClassification.branchLabels.length)return scopeClarification(context);
    if(!useClassification){
      const attention=detectAttention(context.text);
      if(attention)return {...fallback(context,attention,'handoff'),attentionSummary:summarizeAttention(context.text,attention)};
    }
    if(knowledgeUnavailable)return fallback(context,'knowledge_unavailable');
    if (!sources.length) return knowledgeGap(context, replyLanguage(context.text) === 'ar'
      ? 'لا توجد معلومات معتمدة منشورة للمساعد. راجع سؤال العميل وأضف المعلومات المطلوبة.'
      : 'No approved business information is published for the assistant. Review the customer’s question and add the required information.');
    const available = sources;
    const career=careerFaqReply(context,available);if(career)return career;
    const repair=repairFaqReply(context,available,useClassification?.intent==='repair');if(repair)return repair;
    const links=offeredLinks(context,available,useClassification?.intent==='online_links');if(links)return links;
    if(needsProductQuestion(routed,available))return productQuestion(context);
    // Native coordinates and Maps URLs remain verbatim. A typed-area correction
    // is accepted only through the evidence-grounded validation in the resolver.
    const classifiedProduct=useClassification?.product==='btc'||useClassification?.product==='jewelry'?useClassification.product:null;
    const classifiedOrigin=useClassification?.intent==='nearest_branch'
      ?{evidence:useClassification.originEvidence,query:useClassification.originQuery}:null;
    const nearest=await nearestBranchReply(context,available,this.locations,classifiedProduct,classifiedOrigin);if(nearest)return nearest;
    const btcReply=btcBranchReply(routed,available);if(btcReply)return btcReply;
    const branchDetail=directBranchDetail(routed,available);if(branchDetail)return branchDetail;
    const branchDirectory=directJewelryDirectory(routed,available);if(branchDirectory)return branchDirectory;
    // A straightforward return/exchange/refund request is a policy workflow, not
    // a complaint. Restrict its evidence to the approved returns FAQ so an
    // unrelated record cannot outrank the policy or reopen personal follow-up.
    const selection = useClassification?.intent==='returns'
      ? selectReturnsKnowledge(routed,available)
      : selectKnowledge(routed, available);
    sources = selection.sources;
    if (!sources.length) return useClassification?.intent==='returns'||selection.excludedByScope===available.length
      ? knowledgeGap(context,replyLanguage(context.text)==='ar'
        ? 'طلب العميل يخص الاسترجاع أو الاستبدال، لكن سياسة الاسترجاع المعتمدة غير منشورة للمساعد.'
        : 'The customer asked about a return or exchange, but no approved returns policy is published for the assistant.')
      : fallback(context,'knowledge_selection_empty');
    let request: string;
    const answerClassification=useClassification?.intent==='ambiguous'?undefined:useClassification??undefined;
    try { request = buildRequest(routed, sources, selection.coverage,recoveryReason,recoveryAttempt,answerClassification,context.text); } catch { return fallback(context, 'context_too_large'); }
    // Each attempt has a stable, separately budgeted key. Replayed jobs reuse all attempts.
    const reservation = await this.ledger.reserve(context.tenantId, recoveryAttempt?`${context.requestKey}:recovery:${recoveryAttempt}`:context.requestKey, this.purpose);
    if (reservation.status === 'completed') {
      const decision = reservation.decision;
      if (!isAgentDecision(decision)||!sourcesCurrent(decision, available)) return fallback(context, 'cached_knowledge_changed');
      return unsolicitedBranches(routed,decision,available)?scopeClarification(context):renderBranchAnswer(routed,decision,available);
    }
    if (reservation.status !== 'new' || !reservation.id) return fallback(context, reservation.status==='failed'&&reservation.errorCode?reservation.errorCode:`ai_${reservation.status}`);
    const start = Date.now();
    let result: Awaited<ReturnType<ModelProvider['complete']>>;
    try { result = await this.provider.complete(request,{timeoutMs:recoveryAttempt?10000:16000}); }
    catch (error) {
      const known = error instanceof ModelFailure ? error : new ModelFailure('openai_unknown_failure');
      await this.ledger.finish(context.tenantId, reservation.id, { state: 'failed', input: known.usage?.input ?? null,
        output: known.usage?.output ?? null, latency: Date.now()-start, decision: null, error: known.code });
      return fallback(context, known.code);
    }
    const selected = [...new Set(result.decision.sourceLabels)].map(label => sources.find(s => s.label === label));
    const invalidSources = selected.some(s => !s) || (result.decision.action === 'answer' && !selected.length);
    let decision: AgentDecision;
    if(result.decision.action==='career')decision=careerFaqReply(context,available,true)??fallback(context,'answer_not_supported');
    else if (invalidSources) decision = fallback(context, 'invalid_source_reference');
    else if (result.decision.action === 'knowledge_gap') {
      decision = result.decision.sourceLabels.length ? fallback(context, 'invalid_source_reference')
        : knowledgeGap(context, result.decision.summary, selection.coverage.omittedSourceCount > 0);
    }
    else if(useClassification?.intent==='returns'&&(result.decision.action==='handoff'||result.decision.action==='complaint'))
      decision=fallback(context,'invalid_intent_action');
    else if (result.decision.action === 'unavailable' || result.decision.action === 'handoff' || result.decision.action === 'complaint')
      decision = fallback(context, result.decision.action === 'complaint' ? 'complaint' : result.decision.action === 'handoff' ? 'human_requested' : 'answer_not_supported', result.decision.action === 'complaint' ? 'handoff' : result.decision.action);
    else decision = { text: formatReply(formatBranchReply(result.decision.text,result.decision.branchLines)), action: result.decision.action, reason: 'approved_knowledge',
      sources: selected.map(s => ({ id: s!.id, kind: s!.kind, updatedAt: s!.updatedAt })) };
    if (decision.action === 'handoff' && result.decision.summary?.trim()) decision.attentionSummary = result.decision.summary.trim();
    if(unsolicitedBranches(routed,decision,available,result.decision.branchLines))decision=scopeClarification(context);
    if(decision.action==='answer'&&productIntent(routed)==='btc'&&branchScope(routed,available)==='directory'&&!selected.some(s=>s?.kind==='faq'&&bullionPattern.test(normalizeIntent(s.content))))decision=knowledgeGap(context);
    const lastAssistant=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content;
    if(lastAssistant&&isShortAcceptance(context.text??'')&&normalizeIntent(decision.text)===normalizeIntent(lastAssistant))decision=scopeClarification(context);
    const rendered=renderBranchAnswer(routed,decision,available);
    const usedBranchRecord=rendered.text!==decision.text;decision=rendered;
    // Never let the model invent a link, even when it names a valid source.
    if (hasUnsupportedLink(decision.text,selected.filter((s):s is KnowledgeSource=>!!s))) decision = fallback(context, 'unsupported_link');
    if (decision.text.length>4096) decision=fallback(context,'context_too_large');
    if (!usedBranchRecord && replyLanguage(decision.text) !== replyLanguage(context.text)) decision = fallback(context, 'wrong_response_language');
    decision.usage = { model: AI_MODEL, inputTokens: result.input, outputTokens: result.output, costNano: result.input*400+result.output*1600 };
    await this.ledger.finish(context.tenantId, reservation.id, { state: 'completed', input: result.input,
      output: result.output, latency: Date.now()-start, decision, error: null });
    return decision;
  }
}
