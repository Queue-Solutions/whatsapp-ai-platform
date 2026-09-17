import type { AgentDecision } from './contracts';
import type { MessageContext } from '../messaging/types';
import { replyLanguage } from './language';

/** A review flag, not a human handoff. Persist it atomically with the reply intent. */
export function knowledgeGap(context: MessageContext, summary?: string, omittedSources = false): AgentDecision {
  const ar = replyLanguage(context.text ?? '') === 'ar';
  const explanation = summary?.trim() || (ar
    ? 'السؤال محتاج معلومة مش مؤكدة في المعلومات المتاحة للمساعد. راجع السؤال وأضف إجابة معتمدة.'
    : 'The question needs information that the available sources do not confirm. Review the question and add an approved answer.');
  const coverage = omittedSources ? (ar
    ? ' تمت مراجعة معلومات مختارة؛ قد تكون الإجابة موجودة في معلومات محفوظة أخرى.'
    : ' Only selected sources were reviewed; the answer may exist elsewhere in saved knowledge.') : '';
  return {
    action: 'unavailable', reason: 'missing_business_information', sources: [],
    text: ar
      ? 'المعلومة دي مش مؤكدة عندي حالياً ومحتاجة مراجعة من صاحب النشاط. أقدر أساعدك في سؤال تاني، أو تقدر تطلب تتكلم معاه مباشرة.'
      : 'I don’t have confirmed information about that yet; it needs the business owner’s review. I can help with another question, or you can ask to speak to the owner.',
    attentionSummary: explanation.slice(0, 240) + coverage,
  };
}
