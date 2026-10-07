import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {locationWords,matchingBranches,normalizeIntent} from './branch-scope';
import {branchData,sourceRef,numberedBranchLines,contextualBranchRecords,orderedBranchSources} from './branch-dialogue';
import {replyLanguage} from './language';
import {knowledgeGap} from './knowledge-gap';

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

export interface RepairBranchEntry {name:string;hours?:string;sourceId?:string}
export interface RepairBranchCatalog {entries:RepairBranchEntry[];sources:KnowledgeSource[];structured:boolean}

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
  const allBranchSources=sources.flatMap(source=>{
    const value=branchData(source) as unknown as {name?:string;maintenanceEnabled?:boolean;maintenanceHours?:string}|null;
    return value?[{source,value}]:[];
  });
  const structured=allBranchSources.length>0&&allBranchSources.every(item=>Object.prototype.hasOwnProperty.call(item.value,'maintenanceEnabled'));
  if(structured){
    const enabled=allBranchSources.filter(item=>item.value.maintenanceEnabled===true);
    if(enabled.some(item=>!item.value.name?.trim()||!item.value.maintenanceHours?.trim()))return null;
    return {entries:enabled.map(({source,value})=>({name:value.name!.trim(),hours:value.maintenanceHours!.trim(),sourceId:source.id})),sources:enabled.map(item=>item.source),structured:true};
  }
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
  return {entries,sources:catalogs.map(catalog=>catalog.source),structured:false};
}

/** Join an approved maintenance entry to one physical branch by its explicit name, never merely by a shared city. */
export function repairBranchRecords(entry:RepairBranchEntry,sources:KnowledgeSource[]){
  if(entry.sourceId)return sources.filter(source=>source.id===entry.sourceId&&!!branchData(source));
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
  return /technical care working hours and available branches|maintenance branches and working hours|مواعيد العنايه الفنيه والصيانه|فروع الصيانه ومواعيد العمل/.test(normalizeIntent(lastAssistant));
}

export function isRepairEnquiry(text:string){
  const value=normalizeIntent(text);
  return /\b(?:repair|repairs|repaired|repairing|maintenance|technical care)\b|\b(?:need|want|can you|could you|would like to).{0,30}\bfix(?:ed|ing)?\b|\bfix(?:ing)?\b.{0,30}\b(?:necklace|chain|ring|bracelet|jewelry|jewellery|item|product)\b|(?:اصلح|نصلح|يتصلح|تتصلح|تصليح|اصلاح|صيانه)/.test(value);
}

function numberedRepairAnswer(answer:string,branches:string[]){
  const lines=answer.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const start=lines.findIndex(line=>/^(?:available branches|الفروع المتاحه):?$/i.test(normalizeIntent(line)));
  if(start<0)return null;
  const end=lines.findIndex((line,index)=>index>start&&/^(?:you may drop off\b|يمكنك.*(?:تسليم|ترك))/i.test(normalizeIntent(line)));
  if(end<=start||!branches.length)return null;
  return [...lines.slice(0,start+1),...numberedBranchLines(branches),...lines.slice(end)].join('\n');
}
function arabicRepairAnswer(answer:string,branches:string[]){
  if(replyLanguage(answer)==='ar')return numberedRepairAnswer(answer,branches);
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
  if(!branches.length)return null;
  return `مواعيد العناية الفنية والصيانة:\n${schedule}\n\nالفروع المتاحة:\n${numberedBranchLines(branches).join('\n')}\n\nيمكنك أيضًا تسليم القطعة للصيانة في أي فرع آخر من فروعنا، ثم استلامها من الفرع نفسه.`;
}

function structuredRepairReply(context:MessageContext,catalog:RepairBranchCatalog,sources:KnowledgeSource[]):AgentDecision|null {
  if(!catalog.entries.length)return knowledgeGap(context,'No branches are currently enabled for maintenance in Branches.');
  const requested=[...new Set([...matchingBranches(context.text??'',sources),...contextualBranchRecords(context,sources)].map(source=>source.id))];
  const entries=catalog.entries.map((entry,index)=>{
    const records=repairBranchRecords(entry,sources);
    return {entry,index,records,order:Math.min(...records.map(record=>record.branchOrder??Number.MAX_SAFE_INTEGER))};
  }).sort((a,b)=>a.order-b.order||a.index-b.index);
  const selected=requested.length?entries.filter(item=>item.records.some(record=>requested.includes(record.id))):entries;
  const ar=replyLanguage(context.text??'')==='ar';
  if(requested.length&&!selected.length){
    const eligible=numberedBranchLines(entries.map(({entry,records})=>{const data=records.length===1?branchData(records[0]):null;return `${entry.name}${data?.city?` — ${data.city}`:''}`;}));
    return {action:'answer',reason:'approved_knowledge',sources:catalog.sources.map(sourceRef),text:[
      ar?'الفرع المطلوب غير مفعّل لخدمة الصيانة حاليًا. فروع الصيانة المتاحة هي:':'That branch is not currently enabled for maintenance. The available maintenance branches are:',
      eligible.join('\n'),
    ].join('\n\n')};
  }
  const rows=selected.map(({entry,records})=>{
    const record=records.length===1?records[0]:null,data=record?branchData(record):null;
    return `${entry.name}${data?.city?` — ${data.city}`:''}\n   ${ar?'مواعيد الصيانة':'Maintenance hours'}: ${entry.hours}`;
  });
  const refs=orderedBranchSources(selected.flatMap(item=>item.records));
  return {action:'answer',reason:'approved_knowledge',sources:refs.map(sourceRef),text:[
    selected.length===1?(ar?`خدمة الصيانة متاحة في ${selected[0].entry.name}:`:`Maintenance is available at ${selected[0].entry.name}:`)
      :(ar?'فروع الصيانة ومواعيد العمل:':'Maintenance branches and working hours:'),
    (rows.length>1?numberedBranchLines(rows):rows).join('\n'),
  ].join('\n\n')};
}

/** Clear repair requests use the approved technical-care FAQ without a paid model call. */
export function repairFaqReply(context:MessageContext,sources:KnowledgeSource[],force=false):AgentDecision|null {
  if(!force&&!isRepairEnquiry(context.text??''))return null;
  const catalog=repairBranchCatalog(sources);
  if(catalog?.structured)return structuredRepairReply(context,catalog,sources);
  const source=sources.find(isRepairFaq),value=source&&faq(source);
  if(!source||!value)return null;
  const entries=(catalog?.entries??[]).map((entry,index)=>{
    const records=repairBranchRecords(entry,sources);
    return {entry,index,records,order:Math.min(...records.map(record=>record.branchOrder??Number.MAX_SAFE_INTEGER))};
  }).sort((a,b)=>a.order-b.order||a.index-b.index);
  const branchNames=entries.map(item=>item.entry.name);
  const text=replyLanguage(context.text??'')==='ar'?arabicRepairAnswer(value.answer,branchNames):numberedRepairAnswer(value.answer,branchNames);
  if(!text)return null;
  const ar=replyLanguage(context.text??'')==='ar';
  const acknowledgement=ar?'نقدر نساعدك في الصيانة والعناية الفنية.':'IRAM can help with maintenance and technical care.';
  const refs=[source,...entries.flatMap(item=>item.records)];
  return {action:'answer',reason:'approved_knowledge',text:`${acknowledgement}\n\n${text}`,sources:[...new Map(refs.map(item=>[item.id,item])).values()].map(sourceRef)};
}
