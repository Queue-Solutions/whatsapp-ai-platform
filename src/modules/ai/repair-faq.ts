import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {locationWords,normalizeIntent} from './branch-scope';
import {branchData,sourceRef} from './branch-dialogue';
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

export interface RepairBranchEntry {name:string}
export interface RepairBranchCatalog {entries:RepairBranchEntry[];sources:KnowledgeSource[]}

function branchIdentity(value:string){
  const ignored=new Set(['iram','tjh','branch','store','mall','hotel','the','el','al','فرع','الفرع','مول','فندق']);
  return locationWords(value.split(/\s*(?:\(|\[|—|–| - )/)[0]).filter(word=>!ignored.has(word));
}

function catalogEntries(answer:string){
  const lines=answer.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const start=lines.findIndex(line=>/^(?:available branches|الفروع المتاحه):?$/i.test(normalizeIntent(line)));
  if(start<0)return [];
  const end=lines.findIndex((line,index)=>index>start&&/^(?:you may drop off\b|يمكنك.*(?:تسليم|ترك))/i.test(normalizeIntent(line)));
  const selected=lines.slice(start+1,end>start?end:lines.length).map(line=>line
    .replace(/^[\s\t•*-]*(?:\d+️?⃣?)?[.)-]?\s*/u,'').trim()).filter(Boolean);
  return selected.map(name=>({name}));
}

/** Parse the approved technical-care availability list without treating the drop-off exception as service eligibility. */
export function repairBranchCatalog(sources:KnowledgeSource[]):RepairBranchCatalog|null {
  const catalogs=sources.flatMap(source=>{
    const value=faq(source);
    if(!value||!isRepairFaq(source))return [];
    const entries=catalogEntries(value.answer);
    return entries.length?[{source,entries}]:[];
  });
  if(!catalogs.length)return null;
  const signature=(entries:RepairBranchEntry[])=>entries.map(entry=>branchIdentity(entry.name).join(' ')).sort().join('|');
  const expected=signature(catalogs[0].entries);
  if(!expected||catalogs.some(catalog=>signature(catalog.entries)!==expected))return null;
  const entries=[...new Map(catalogs[0].entries.map(entry=>[branchIdentity(entry.name).join(' '),entry])).values()];
  if(entries.length!==catalogs[0].entries.length||entries.some(entry=>!branchIdentity(entry.name).length))return null;
  return {entries,sources:catalogs.map(catalog=>catalog.source)};
}

/** Join an approved maintenance entry to one physical branch by its explicit name, never merely by a shared city. */
export function repairBranchRecords(entry:RepairBranchEntry,sources:KnowledgeSource[]){
  const expected=branchIdentity(entry.name);
  return sources.filter(source=>{
    const data=branchData(source);if(!data?.name)return false;
    const actual=branchIdentity(data.name);
    return actual.length===expected.length&&expected.every((word,index)=>word===actual[index]);
  });
}

/** The immediately preceding assistant reply established technical-care branch scope. */
export function continuesRepairService(context:MessageContext){
  const lastAssistant=[...(context.history??[])].reverse().find(message=>message.role==='assistant')?.content??'';
  return /technical care working hours and available branches|مواعيد العنايه الفنيه والصيانه/.test(normalizeIntent(lastAssistant));
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
  return `مواعيد العناية الفنية والصيانة:\n${schedule}\n\nالفروع المتاحة:\n${branches.map(branch=>`• ${branch}`).join('\n')}\n\nيمكنك أيضًا تسليم القطعة للصيانة في أي فرع آخر من فروعنا، ثم استلامها من الفرع نفسه.`;
}

/** Clear repair requests use the approved technical-care FAQ without a paid model call. */
export function repairFaqReply(context:MessageContext,sources:KnowledgeSource[],force=false):AgentDecision|null {
  if(!force&&!isRepairEnquiry(context.text??''))return null;
  const source=sources.find(isRepairFaq),value=source&&faq(source);
  if(!source||!value)return null;
  const text=replyLanguage(context.text??'')==='ar'?arabicRepairAnswer(value.answer):value.answer.trim();
  if(!text)return null;
  return {action:'answer',reason:'approved_knowledge',text,sources:[sourceRef(source)]};
}
