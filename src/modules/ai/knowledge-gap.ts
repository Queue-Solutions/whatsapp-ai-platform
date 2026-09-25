import type { AgentDecision } from './contracts';
import type { MessageContext } from '../messaging/types';
import { replyLanguage } from './language';

/** A review flag, not a human handoff. Persist it atomically with the reply intent. */
export function knowledgeGap(context: MessageContext, summary?: string, omittedSources = false): AgentDecision {
  const ar = replyLanguage(context.text ?? '') === 'ar';
  const explanation = summary?.trim() || (ar
    ? 'يتطلب السؤال معلومة غير مؤكدة ضمن المعلومات المتاحة للمساعد. يرجى مراجعة السؤال وإضافة إجابة معتمدة.'
    : 'The question needs information that the available sources do not confirm. Review the question and add an approved answer.');
  const coverage = omittedSources ? (ar
    ? ' تمت مراجعة معلومات مختارة، وقد تكون الإجابة موجودة ضمن معلومات محفوظة أخرى.'
    : ' Only selected sources were reviewed; the answer may exist elsewhere in saved knowledge.') : '';
  return {
    action: 'unavailable', reason: 'missing_business_information', sources: [],
    text: ar
      ? 'هذه المعلومة غير مؤكدة لدي حاليًا وتحتاج إلى مراجعة من فريق IRAM. يمكنني مساعدتك في استفسار آخر، أو يمكنك طلب التحدث مع أحد ممثلي الفريق.'
      : 'I don’t currently have confirmed information about that. I can assist with another enquiry, or you may ask to speak with an IRAM representative.',
    attentionSummary: explanation.slice(0, 240) + coverage,
  };
}
