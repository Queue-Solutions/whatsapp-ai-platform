import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {normalizeIntent} from './branch-scope';
import {sourceRef} from './branch-dialogue';
import {replyLanguage} from './language';

function faq(source:KnowledgeSource):{question:string;answer:string}|null {
  if(source.kind!=='faq')return null;
  try {
    const value=JSON.parse(source.content) as {question?:unknown;answer?:unknown};
    return typeof value.question==='string'&&typeof value.answer==='string'&&value.answer.trim()?{question:value.question,answer:value.answer}:null;
  } catch { return null; }
}

function isRepairFaq(source:KnowledgeSource){
  const value=faq(source);if(!value)return false;
  return /\b(?:technical care|maintenance|repair)\b|صيانه|تصليح|اصلاح/.test(normalizeIntent(value.question));
}

export function isRepairEnquiry(text:string){
  const value=normalizeIntent(text);
  return /\b(?:repair|repairs|repaired|repairing|maintenance|technical care)\b|\b(?:need|want|can you|could you|would like to).{0,30}\bfix(?:ed|ing)?\b|\bfix(?:ing)?\b.{0,30}\b(?:necklace|chain|ring|bracelet|jewelry|jewellery|item|product)\b|(?:اصلح|نصلح|يتصلح|تتصلح|تصليح|اصلاح|صيانه)/.test(value);
}

function arabicRepairAnswer(answer:string){
  if(replyLanguage(answer)==='ar')return answer.trim();
  const lines=answer.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const scheduleLine=lines.find(line=>/^daily from\b/i.test(line));
  const availableIndex=lines.findIndex(line=>/^available branches:?$/i.test(line));
  const dropIndex=lines.findIndex(line=>/^you may drop off\b/i.test(line));
  if(!scheduleLine||availableIndex<0||dropIndex<=availableIndex+1)return null;
  const schedule=scheduleLine
    .replace(/^daily from\b/i,'يوميًا من')
    .replace(/\bexcept sunday\s*\(weekly day off\)/i,'ما عدا يوم الأحد (الإجازة الأسبوعية)')
    .replace(/\band friday from\b/i,'ويوم الجمعة من')
    .replace(/\bto\b/gi,'إلى');
  if(/\b(?:daily|except|sunday|weekly|friday|from|to)\b/i.test(schedule))return null;
  const branches=lines.slice(availableIndex+1,dropIndex).map(line=>line.replace(/^[\s\t•*-]*(?:\d+\ufe0f?\u20e3?)?[.)-]?\s*/u,'').trim()).filter(Boolean);
  if(!branches.length)return null;
  return `شكرًا لتواصلك مع IRAM Jewelry 💎\n\nمواعيد العناية الفنية والصيانة:\n${schedule}\n\nالفروع المتاحة:\n${branches.map(branch=>`• ${branch}`).join('\n')}\n\nتقدر كمان تسلّم القطعة للصيانة في أي فرع من فروعنا الأخرى، وتستلمها بعد كده من نفس الفرع.`;
}

/** Clear repair requests use the approved technical-care FAQ without a paid model call. */
export function repairFaqReply(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  if(!isRepairEnquiry(context.text??''))return null;
  const source=sources.find(isRepairFaq),value=source&&faq(source);
  if(!source||!value)return null;
  const text=replyLanguage(context.text??'')==='ar'?arabicRepairAnswer(value.answer):value.answer.trim();
  if(!text)return null;
  return {action:'answer',reason:'approved_knowledge',text,sources:[sourceRef(source)]};
}
