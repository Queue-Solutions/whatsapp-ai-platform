import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {normalizeIntent} from './branch-scope';
import {sourceRef} from './branch-dialogue';
import {confirmsCareer,isCareerEnquiry} from './follow-up';
import {replyLanguage} from './language';

function faq(source:KnowledgeSource):{question:string;answer:string}|null {
  if(source.kind!=='faq')return null;
  try {
    const value=JSON.parse(source.content) as {question?:unknown;answer?:unknown};
    return typeof value.question==='string'&&typeof value.answer==='string'&&value.answer.trim()?{question:value.question,answer:value.answer}:null;
  } catch { return null; }
}

function isCareerFaq(source:KnowledgeSource){
  const value=faq(source);
  return !!value&&/(?:\b(?:hr|human resources?|job|vacanc|career|employment|hiring|recruit)\w*\b|وظيف|وظائف|وظايف|توظيف|فرص عمل|الموارد البشريه|موارد بشريه|اتش\s*ار)/.test(normalizeIntent(value.question));
}

function localizedAnswer(answer:string,context:MessageContext){
  const email=answer.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0];
  if(email&&/\b(?:cv|resume|résumé)\b/i.test(answer))return replyLanguage(context.text??'')==='ar'
    ? `من فضلك ابعت السيرة الذاتية على إيميل الموارد البشرية:\n${email}`
    : `Please send your CV to the Human Resources email address:\n${email}`;
  return answer.trim();
}

/** FAQ display numbers can change. Match the approved job-vacancy question that is currently shown as FAQ 9. */
export function careerFaqReply(context:MessageContext,sources:KnowledgeSource[],force=false):AgentDecision|null {
  if(!force&&!(isCareerEnquiry(context.text??'')||confirmsCareer(context)))return null;
  const source=sources.find(isCareerFaq);
  const value=source&&faq(source);
  if(!source||!value)return null;
  return {action:'answer',reason:'approved_knowledge',text:localizedAnswer(value.answer,context),sources:[sourceRef(source)]};
}
