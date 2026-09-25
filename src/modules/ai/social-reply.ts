import type { AgentDecision } from './contracts';

/** Exact, whole-message matches only: a greeting attached to a question must reach knowledge handling. */
export function socialReply(text:string,history:ReadonlyArray<{role:'user'|'assistant';content:string}>=[],hint?:'greeting'|'thanks'):AgentDecision|null {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const wellbeing=/^(?:how are (?:you|u)(?: doing)?|how s it going|what s up|whats up|wassup|sup|ازيك|ازيكم|عامل ايه|عاملين ايه)$/;
  const greetings = /^(?:hi+|hello+|hey+|hi there|hello there|hey there|good morning|good afternoon|good evening|اهلا|اهلا بيك|اهلا وسهلا|مرحبا|هاي|هلا|السلام عليكم|السلام عليكم ورحمة الله|السلام عليكم ورحمة الله وبركاته|صباح الخير|صباح النور|مساء الخير|مساء النور)$/;
  const thanks = /^(?:(?:ok|okay|alright|تمام) )?(?:thanks|thank you|thanks a lot|thank you so much|thank you very much|thanks so much|many thanks|شكرا|شكرا ليك|شكرا جزيلا|متشكر|متشكرة|تسلم|تسلمي|تسلموا)$/;
  const ar = /\p{Script=Arabic}/u.test(normalized);
  const isThanks=thanks.test(normalized)||hint==='thanks';
  const isWellbeing=wellbeing.test(normalized);
  const isGreeting=isWellbeing||greetings.test(normalized)||hint==='greeting';
  if(isWellbeing)return {action:'clarify',reason:'social_greeting',sources:[],text:ar
    ? 'أنا بخير، شكرًا لسؤالك.\n\nكيف يمكنني مساعدتك؟'
    : 'I’m doing well, thank you for asking.\n\nHow may I assist you?'};
  if(isGreeting){
    const returning=history.some(message=>message.role==='assistant');
    return {action:'clarify',reason:'social_greeting',sources:[],text:returning
      ? ar?'أهلًا بعودتك إلى IRAM.\n\nكيف يمكنني مساعدتك؟':'Welcome back to IRAM.\n\nHow may I assist you?'
      : ar?'أهلًا بك في IRAM ✨\n\nهل ترغب في الاستفسار عن المجوهرات أم منتجات BTC والسبائك؟':'Welcome to IRAM ✨\n\nWould you like assistance with jewelry or BTC / bullion products?'};
  }
  if (isThanks) return { action: 'clarify', reason: 'social_thanks', sources: [],
    text: ar ? 'على الرحب والسعة.\n\nيسعدني مساعدتك في أي استفسار آخر يخص IRAM.' : 'You’re welcome.\n\nI’ll be pleased to assist with any other IRAM enquiry.' };
  return null;
}
