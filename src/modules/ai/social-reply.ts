import type { AgentDecision } from './contracts';

/** Exact, whole-message matches only: a greeting attached to a question must reach knowledge handling. */
export function socialReply(text:string,history:ReadonlyArray<{role:'user'|'assistant';content:string}>=[],hint?:'greeting'|'thanks'):AgentDecision|null {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  // Canonicalize only conversational shorthand. Keeping this separate from the
  // original text prevents broad substitutions from changing business queries.
  const conversational=normalized.replace(/\b(?:what s|whats)\b/g,'what is').replace(/\b(?:who s|whos)\b/g,'who is').replace(/\b(?:how s|hows)\b/g,'how is')
    .replace(/\bur\b/g,'your').replace(/\bu\b/g,'you').replace(/\br\b/g,'are');
  const identity=/^(?:who are you|who is this|what are you|what is your name|what are you called|may i know your name|are you (?:a )?(?:bot|robot|ai|assistant)|مين انت|من انت|انت مين|انت ايه|اسمك ايه|هل انت (?:بوت|روبوت|مساعد))$/;
  const wellbeing=/^(?:how are you(?: doing)?|how is it going|what is up|wassup|sup|ازيك|ازيكم|عامل ايه|عاملين ايه)$/;
  const greetings = /^(?:hi+|hello+|hey+|hi there|hello there|hey there|good morning|good afternoon|good evening|اهلا|اهلا بيك|اهلا وسهلا|مرحبا|هاي|هلا|السلام عليكم|السلام عليكم ورحمة الله|السلام عليكم ورحمة الله وبركاته|صباح الخير|صباح النور|مساء الخير|مساء النور)$/;
  const thanks = /^(?:(?:ok|okay|alright|تمام) )?(?:thanks|thank you|thanks a lot|thank you so much|thank you very much|thanks so much|many thanks|شكرا|شكرا ليك|شكرا جزيلا|متشكر|متشكرة|تسلم|تسلمي|تسلموا)$/;
  const ar = /\p{Script=Arabic}/u.test(normalized);
  const isThanks=thanks.test(normalized)||hint==='thanks';
  const isWellbeing=wellbeing.test(conversational);
  const isGreeting=isWellbeing||greetings.test(normalized)||hint==='greeting';
  // `clarify` is the existing database-safe action for deterministic, source-free
  // conversational replies. The text answers the identity question directly.
  if(identity.test(conversational))return {action:'clarify',reason:'social_identity',sources:[],text:ar
    ? 'أنا مساعد IRAM المدعوم بالذكاء الاصطناعي، وموجود لمساعدتك في أي استفسار عن منتجاتنا وخدماتنا. وإذا رغبت في التحدث مع أحد ممثلي IRAM شخصيًا، اطلب ذلك في أي وقت.'
    : 'I’m IRAM’s AI-powered assistant, here to help with any question about our products and services. If you would prefer to speak with an IRAM representative, just ask at any time.'};
  if(isWellbeing)return {action:'clarify',reason:'social_greeting',sources:[],text:ar
    ? 'أنا بخير، شكرًا لسؤالك.\n\nكيف يمكنني مساعدتك؟'
    : 'I’m doing well, thank you for asking.\n\nHow may I assist you?'};
  if(isGreeting){
    const returning=history.some(message=>message.role==='assistant');
    return {action:'clarify',reason:'social_greeting',sources:[],text:returning
      ? ar?'أهلًا بعودتك إلى IRAM ✨\n\nأنا مساعد IRAM المدعوم بالذكاء الاصطناعي. كيف يمكنني مساعدتك اليوم؟\n\nوإذا رغبت في التحدث مع أحد ممثلي IRAM شخصيًا، اطلب ذلك في أي وقت.':'Welcome back to IRAM ✨\n\nI’m IRAM’s AI-powered assistant. How may I help today?\n\nIf you would prefer to speak with an IRAM representative, just ask at any time.'
      : ar?'أهلًا وسهلًا بك في IRAM ✨\n\nأنا مساعد IRAM المدعوم بالذكاء الاصطناعي، وموجود لمساعدتك في أي استفسار عن منتجاتنا وخدماتنا، مثل المجوهرات، ومنتجات BTC والسبائك، والفروع، والصيانة، والاستبدال والاسترجاع.\n\nكيف يمكنني مساعدتك اليوم؟\n\nوإذا رغبت في التحدث مع أحد ممثلي IRAM شخصيًا، اطلب ذلك في أي وقت.':'Welcome to IRAM ✨\n\nI’m IRAM’s AI-powered assistant, here to help with any question about our products and services, including jewelry, BTC and bullion, branches, maintenance, exchanges and returns.\n\nHow may I help today?\n\nIf you would prefer to speak with an IRAM representative, just ask at any time.'};
  }
  if (isThanks) return { action: 'clarify', reason: 'social_thanks', sources: [],
    text: ar ? 'على الرحب والسعة.\n\nيسعدني مساعدتك في أي استفسار آخر يخص IRAM.' : 'You’re welcome.\n\nI’ll be pleased to assist with any other IRAM enquiry.' };
  return null;
}
