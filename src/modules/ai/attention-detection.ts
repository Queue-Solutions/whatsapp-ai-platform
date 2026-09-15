/** High-signal requests work without a model call, including when knowledge/budget is unavailable. */
export function detectAttention(text: string): 'human_requested' | 'complaint' | null {
  const normalized = text.normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا');
  const contextualComplaint = /\b(?:if|policy|policies)\b|(?:^|\s)(?:لو|سياسة|السياسة)(?:\s|$)|(?:don't|do not).{0,20}(?:refund|complain)|not a complaint|مش عايز اشتكي/i.test(normalized);
  if (!contextualComplaint && (/\b(?:my (?:order|item|product|delivery).{0,45}(?:damaged|broken|wrong|missing|never arrived|not arrived)|(?:received|sent me|delivered).{0,20}(?:wrong|damaged|broken)|(?:want|need|request).{0,20}(?:a |my )?refund(?!\s+(?:policy|information|details))|(?:terrible|awful|bad|poor|rude) (?:service|experience|staff)|(?:make|file|raise).{0,15}complaint|still (?:not fixed|not resolved|waiting))\b/i.test(normalized)
    || /(?:عايز|عاوز|اريد).{0,20}(?:اشتكي|اقدم شكوى|فلوسي ترجع|استرد فلوسي)|(?:الطلب|الاوردر|المنتج).{0,30}(?:مكسور|تالف|غلط|موصلش|ماوصلش)|(?:خدمه|خدمة|معامله|معاملة).{0,15}(?:سيئه|سيئة|وحشه|وحشة)|(?:محدش|ماحدش).{0,15}بيرد/.test(normalized))) return 'complaint';
  if (/\b(speak|talk|connect|transfer).{0,35}\b(human|person|agent|staff|owner|someone)\b|\b(human|real person)\b|(?:عايز|عاوز|ممكن|اريد).{0,30}(?:موظف|بني ادم|حد من|خدمة العملاء|اكلم حد|اتكلم مع حد|صاحب)|(?:كلمني|وصلني).{0,20}(?:موظف|حد)/i.test(normalized)) return 'human_requested';
  return null;
}

export function summarizeAttention(text:string,reason:'human_requested'|'complaint') {
  if(reason==='human_requested')return 'The customer asked to speak to you personally.';
  if(/damaged|broken|مكسور|تالف/i.test(text))return 'The customer reports receiving a damaged or broken item.';
  if(/wrong|غلط/i.test(text))return 'The customer reports receiving an incorrect order or item.';
  if(/refund|فلوسي/i.test(text))return 'The customer is requesting a refund.';
  if(/not arrived|never arrived|موصلش|ماوصلش/i.test(text))return 'The customer reports that their delivery has not arrived.';
  if(/service|experience|staff|خدمة|خدمه|معامله|معاملة/i.test(text))return 'The customer reports a poor service experience.';
  return 'The customer has raised an unresolved issue and needs your help.';
}
