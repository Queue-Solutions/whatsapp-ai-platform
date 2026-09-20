import type { AgentDecision } from './contracts';

/** Exact, whole-message matches only: a greeting attached to a question must reach knowledge handling. */
export function socialReply(text: string): AgentDecision | null {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const greetings = /^(?:hi+|hello+|hey+|hi there|hello there|hey there|good morning|good afternoon|good evening|how are you|how are you doing|whats up|what s up|wassup|sup|اهلا|اهلا بيك|اهلا وسهلا|مرحبا|هاي|هلا|السلام عليكم|السلام عليكم ورحمة الله|السلام عليكم ورحمة الله وبركاته|صباح الخير|صباح النور|مساء الخير|مساء النور|ازيك|ازيكم|عامل ايه|عاملين ايه)$/;
  const thanks = /^(?:(?:ok|okay|alright|تمام) )?(?:thanks|thank you|thanks a lot|thank you so much|thank you very much|thanks so much|many thanks|شكرا|شكرا ليك|شكرا جزيلا|متشكر|متشكرة|تسلم|تسلمي|تسلموا)$/;
  const ar = /\p{Script=Arabic}/u.test(normalized);
  if (greetings.test(normalized)) return { action: 'clarify', reason: 'social_greeting', sources: [],
    text: ar ? 'أهلًا بيك في IRAM ✨\n\nنوّرتنا! مهتم بالمجوهرات ولا منتجات BTC والسبائك؟ 🤍' : 'Welcome to IRAM ✨\n\nLovely to have you here! Are you interested in jewelry or BTC / bullion products? 🤍' };
  if (thanks.test(normalized)) return { action: 'clarify', reason: 'social_thanks', sources: [],
    text: ar ? 'العفو، ده يسعدنا 🤍\n\nلو محتاج أي حاجة تانية، أنا معاك.' : 'You’re very welcome 🤍\n\nIf you need anything else, I’m here to help.' };
  return null;
}
