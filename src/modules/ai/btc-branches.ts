import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {activeBranchRecord,branchData,productIntent,sourceRef,bullionPattern,contextualBranchRecords,branchReplyArabic,numberedBranchLines} from './branch-dialogue';
import {branchScope,isBranchSource,normalizeIntent,locationWords,matchingBranches} from './branch-scope';
import {knowledgeGap} from './knowledge-gap';

interface BtcEntry {name:string;phone:string;hours?:string;sourceId?:string}
interface BtcCatalog {entries:BtcEntry[];hours:string[];sources:KnowledgeSource[]}
const question8=normalizeIntent('What information can you provide about your bullion or BTC products?');
const digits=(text:string)=>text.replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c<='٩'?1632:1776)));
const goldCoinRequest=(text:string)=>/\bgold coins?\b|جنيهات? (?:ال)?(?:ذهب|دهب)|جنيه (?:ال)?(?:ذهب|دهب)/.test(normalizeIntent(text));
/** Identity aliases only, never a list of branches providing BTC. Availability always comes from the FAQ. */
function nameWords(text:string){
  return locationWords(text.replace(/[()\[\]—–_-]/g,' ')).join(' ')
    .replace(/\b(?:corba|korba)\b|(?:ال)?كوربه/g,'korba')
    .replace(/\bcity\s*stars\b|سيتي\s*ستارز|سيتى\s*ستارز/g,'citystars')
    .replace(/\bnox\b|نوكس/g,'nox').replace(/\bmivida\b|ميفيدا/g,'mivida')
    .replace(/\bmaadi\b|(?:ال)?معادي|(?:ال)?معادى/g,'maadi')
    .replace(/\barkan\b|اركان/g,'arkan').replace(/(?<![\p{L}\p{N}])(?:iram|ايرام|ارم)(?![\p{L}\p{N}])/gu,'iram')
    .split(/\s+/).filter(Boolean);
}
const meaningful=(words:string[])=>words.filter(w=>!['iram','tjh','branch','فرع','الفرع','mall','the'].includes(w));
const key=(name:string)=>nameWords(name).join(' ');

/** Parse the approved name:BTC-phone rows. An unparseable/conflicting catalog never falls back to the jewelry directory. */
export function btcCatalog(sources:KnowledgeSource[]):BtcCatalog|null {
  const allBranchSources=sources.flatMap(source=>{
    const value=branchData(source) as unknown as {name?:string;btcEnabled?:boolean;btcHours?:string;btcPhone?:string}|null;
    return value?[{source,value}]:[];
  });
  const structured=allBranchSources.length>0&&allBranchSources.every(item=>Object.prototype.hasOwnProperty.call(item.value,'btcEnabled'));
  if(structured){
    const enabled=allBranchSources.filter(item=>item.value.btcEnabled===true);
    if(enabled.some(item=>!item.value.name?.trim()||!item.value.btcHours?.trim()||!item.value.btcPhone?.trim()))return null;
    return {entries:enabled.map(({source,value})=>({name:value.name!.trim(),phone:value.btcPhone!.trim(),hours:value.btcHours!.trim(),sourceId:source.id})),hours:[],sources:enabled.map(item=>item.source)};
  }
  const candidates=sources.flatMap(source=>{
    if(source.kind!=='faq')return [];
    try{
      const data=JSON.parse(source.content);
      return typeof data.question==='string'&&typeof data.answer==='string'&&bullionPattern.test(normalizeIntent(data.question))
        ?[{source,question:normalizeIntent(data.question),answer:data.answer}]:[];
    }catch{return [];}
  });
  const exact=candidates.filter(c=>c.question===question8);
  const selected=exact.length?exact:candidates;
  const catalogs=selected.flatMap(({source,answer})=>{
    const entries:BtcEntry[]=[],hours:string[]=[];let invalid=false;
    for(const raw of answer.split(/[\r\n;؛]+/)){
      const line=raw.replace(/^\s*(?:[•*\-]|\d+[.)])\s*/,'').trim();if(!line)continue;
      const row=line.match(/^([^:\n]{2,120})\s*[:：]\s*([+\d٠-٩۰-۹ ()-]{7,30})\s*[.]?$/u);
      if(row){
        const phone=digits(row[2]).replace(/[^\d+]/g,'');
        if((!/^(?:iram|tjh|ارم|ايرام)(?=\s|$)/i.test(normalizeIntent(row[1]))&&!btcBranchRecords({name:row[1].trim(),phone},sources).length)||!/^\+?\d{7,15}$/.test(phone)||/https?:|\b(?:not|unavailable|except)\b|غير متاح|لا يوجد/i.test(row[1])){invalid=true;continue;}
        entries.push({name:row[1].trim(),phone});
      }else if(/(?:btc|bullion).*(?:hours|times)|(?:hours|times).*btc|(?:مواعيد|ساعات).*?(?:btc|سبائك)|(?:btc|سبائك).*?(?:مواعيد|ساعات)/i.test(normalizeIntent(line))){
        hours.push(line);
      }else if(/^(?:iram|tjh|ارم|ايرام)(?=\s|$)/i.test(normalizeIntent(line))){
        // A malformed branch row means the list may be incomplete; do not silently omit it.
        invalid=true;
      }
    }
    return entries.length||invalid?[{source,entries,hours,invalid}]:[];
  });
  if(!catalogs.length||catalogs.some(c=>c.invalid||!c.entries.length))return null;
  // Multiple approved versions must agree on the branch/phone mapping, rather than expanding eligibility by union.
  const signature=(entries:BtcEntry[])=>entries.map(e=>`${key(e.name)}:${e.phone}`).sort().join('|');
  if(catalogs.some(c=>signature(c.entries)!==signature(catalogs[0].entries)))return null;
  const entries=[...new Map(catalogs[0].entries.map(e=>[key(e.name),e])).values()];
  if(entries.length!==catalogs[0].entries.length)return null;
  return {entries,hours:[...new Set(catalogs.flatMap(c=>c.hours))],sources:catalogs.map(c=>c.source)};
}

/** Join by branch identity, never by shared city, address, phone or a best-effort fuzzy score. */
export function btcBranchRecords(entry:BtcEntry,sources:KnowledgeSource[]){
  if(entry.sourceId)return sources.filter(source=>source.id===entry.sourceId&&!!branchData(source));
  const identity=(name:string)=>nameWords(name.split(/\s*(?:\(|\[|—|–| - )/)[0]);
  const expected=identity(entry.name);
  return sources.filter(source=>{
    const data=branchData(source);if(!data?.name)return false;
    const actual=identity(data.name);
    return expected.length>0&&actual.length===expected.length&&expected.every((word,index)=>actual[index]===word);
  });
}
export function constrainBtcSources(context:MessageContext,sources:KnowledgeSource[]){
  if(productIntent(context)!=='btc')return sources;
  const catalog=btcCatalog(sources);
  const allowed=new Set(catalog?.entries.flatMap(e=>btcBranchRecords(e,sources)).map(s=>s.id)??[]);
  return sources.filter(s=>branchData(s)?allowed.has(s.id):!isBranchSource(s)||catalog?.sources.some(c=>c.id===s.id));
}
function hoursText(hours:string[],ar:boolean){
  return hours.map(line=>{
    const value=line.replace(/^(?:BTC\s+)?(?:working\s+)?hours\s*:\s*/i,'');
    if(!ar)return `BTC service hours: ${value}`;
    return `مواعيد خدمة BTC: ${value.replace(/daily from/gi,'يوميًا من').replace(/except friday from/gi,'ما عدا الجمعة من')
      .replace(/\bto\b/gi,'إلى').replace(/\bPM\b/gi,'مساءً').replace(/\bAM\b/gi,'صباحًا')}`;
  }).join('\n');
}
function orderedEntries(entries:BtcEntry[],sources:KnowledgeSource[]){
  return entries.map((entry,index)=>({entry,index,order:Math.min(...btcBranchRecords(entry,sources).map(source=>source.branchOrder??Number.MAX_SAFE_INTEGER))}))
    .sort((a,b)=>a.order-b.order||a.index-b.index).map(item=>item.entry);
}
function directory(context:MessageContext,catalog:BtcCatalog,sources:KnowledgeSource[],entries=catalog.entries,unlisted=false):AgentDecision {
  const ar=branchReplyArabic(context);entries=orderedEntries(entries,sources);
  const goldCoins=goldCoinRequest(context.text??'');
  const refs=[...catalog.sources];
  const distinctEntryHours=[...new Set(entries.map(entry=>entry.hours?.trim()).filter((value):value is string=>!!value))];
  const sharedEntryHours=distinctEntryHours.length===1?distinctEntryHours[0]:'';
  const lines=numberedBranchLines(entries.map(entry=>{
    const records=btcBranchRecords(entry,sources);
    const city=records.length===1?branchData(records[0])?.city:'';
    if(city)refs.push(records[0]);
    const serviceHours=entry.hours&&!sharedEntryHours?`\n   ${hoursText([entry.hours],ar)}`:'';
    return `${entry.name}${city?` — ${city}`:''}${serviceHours}`;
  }));
  const intro=unlisted?(ar?'الفرع ده مش مدرج ضمن فروع BTC المؤكدة. دي الفروع المتاحة لو حابب تختار فرعًا آخر:':'That branch is not currently listed for BTC / bullion service. If you’d like another option, these branches do offer it:')
    :goldCoins
      ?ar?'أيوه، جنيهات الذهب متاحة لدى IRAM من خلال خدمة BTC والسبائك في الفروع دي:':'Yes, IRAM offers gold coins through its BTC / bullion service at these branches:'
      :entries.length<catalog.entries.length
        ?ar?'دي فروع خدمة BTC والسبائك المطابقة للمكان اللي سألت عنه:':'Here are the BTC / bullion branches matching the location you asked about:'
        :ar?'أكيد، خدمة BTC والسبائك متاحة في الفروع دي:':'Sure — here are our branches with BTC / bullion service:';
  const hours=hoursText([...catalog.hours,...(sharedEntryHours?[sharedEntryHours]:[])],ar);
  return {action:'answer',reason:'approved_knowledge',sources:[...new Map(refs.map(s=>[s.id,s])).values()].map(sourceRef),
    text:[intro,lines.join('\n'),hours,ar?'اكتب رقم الفرع أو اسمه لعرض العنوان الكامل ورابط الموقع ورقم خدمة BTC.':'Reply with a branch number or name for its full address, location link and BTC phone number.'].filter(Boolean).join('\n\n')};
}
function details(context:MessageContext,catalog:BtcCatalog,entry:BtcEntry,sources:KnowledgeSource[]):AgentDecision {
  return detailsForEntries(context,catalog,[entry],sources);
}
function detailsForEntries(context:MessageContext,catalog:BtcCatalog,entries:BtcEntry[],sources:KnowledgeSource[],availability=false):AgentDecision {
  const ar=branchReplyArabic(context),refs=[...catalog.sources];entries=orderedEntries(entries,sources);
  const blocks=entries.map(entry=>{
    const matches=btcBranchRecords(entry,sources),record=matches.length===1?matches[0]:null,data=record?branchData(record):null;
    if(record)refs.push(record);
    return [`${entry.name}${data?.city?` — ${data.city}`:''}`,
      data?.address?.trim()||(ar?'العنوان الكامل غير مؤكد لهذا الفرع حاليًا.':'The full address is not confirmed for this branch right now.'),
      data?.mapsUrl?.trim()||(ar?'رابط الموقع غير متاح لهذا الفرع حاليًا.':'A location link is not currently available for this branch.'),
      `${ar?'رقم خدمة BTC':'BTC phone'}: ${entry.phone}`,
      entry.hours?hoursText([entry.hours],ar):''].filter(Boolean).join('\n\n');
  });
  return {action:'answer',reason:'approved_knowledge',sources:[...new Map(refs.map(source=>[source.id,source])).values()].map(sourceRef),text:[
    availability&&entries.length===1
      ?(ar?`أيوه، خدمة BTC والسبائك متاحة في ${entries[0].name}. دي التفاصيل:`:`Yes — BTC / bullion service is available at ${entries[0].name}. Here are the details:`)
      :entries.length>1?(ar?'دي تفاصيل فروع BTC والسبائك اللي طلبتها:':'Here are the requested BTC / bullion branch details:')
      :(ar?`دي تفاصيل ${entries[0].name}:`:`Here are the details for ${entries[0].name}:`),
    (blocks.length>1?numberedBranchLines(blocks):blocks).join('\n\n——\n\n'),hoursText(catalog.hours,ar),
    availability&&catalog.entries.length>1?(ar?'الخدمة متاحة كمان في فروع أخرى. لو حابب، اطلب مني القائمة الكاملة وسأعرضها لك.':'We also offer this service at other branches. If you’d like, ask me for the full list and I’ll show it to you.'):''
  ].filter(Boolean).join('\n\n')};
}

const availabilityQuestion=(text:string)=>/\b(?:do|does|is|are|have|has|offer|available|provide|carry)\b.{0,60}\b(?:btc|bullion)\b|\b(?:btc|bullion)\b.{0,60}\b(?:available|service|there)\b|(?:هل|فيه|عندكم|متاح|موجود).{0,50}(?:btc|سبائك)|(?:btc|سبائك).{0,50}(?:متاح|موجود|خدمه)/.test(normalizeIntent(text));
const currentBranchFollowUp=(text:string)=>/\b(?:this|that|same)\s+(?:branch|store)\b|\b(?:it|there)\b|(?:الفرع ده|هذا الفرع|نفس الفرع|عنده|فيه)/.test(normalizeIntent(text));
const serviceDetailFollowUp=(text:string)=>/\b(?:btc|bullion)?\s*(?:phone|number|hours|details)\b|(?:رقم|تليفون|مواعيد|تفاصيل).{0,25}(?:btc|سبائك)?/.test(normalizeIntent(text));
function unavailableAtBranch(context:MessageContext,catalog:BtcCatalog,branch:KnowledgeSource):AgentDecision {
  const ar=branchReplyArabic(context),name=branchData(branch)?.name?.trim()||'this branch';
  return {action:'answer',reason:'approved_knowledge',sources:[...new Map([...catalog.sources,branch].map(source=>[source.id,source])).values()].map(sourceRef),
    text:ar?`خدمة BTC والسبائك غير مدرجة حاليًا ضمن خدمات ${name}. لو حابب، أقدر أعرض لك قائمة الفروع المتاحة فيها الخدمة.`
      :`BTC / bullion service is not currently listed as available at ${name}. If you’d like, I can show you the branches that do offer it.`};
}

/** Directory and branch-detail replies are constructed from source fields; the model cannot add branches or swap phones. */
export function btcBranchReply(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  if(productIntent(context)!=='btc')return null;
  const scope=branchScope(context,sources),catalog=btcCatalog(sources);
  const goldCoins=goldCoinRequest(context.text??'');
  const queryWords=new Set(nameWords(context.text??''));
  const named=catalog?.entries.filter(e=>meaningful(nameWords(e.name)).every(w=>queryWords.has(w)))??[];
  const requestedRecords=matchingBranches(context.text??'',sources);
  const contextualRecords=contextualBranchRecords(context,sources);
  const focusedProduct=/\b(?:price|prices|cost|payment|refund|warranty|weight|karat)\b|اسعار|سعر|بكام|دفع|استرجاع|ضمان|عيار|وزن/.test(normalizeIntent(context.text??''));
  if(focusedProduct)return null;
  if(scope==='none'&&!named.length&&!requestedRecords.length&&!contextualRecords.length&&!goldCoins)return null;
  if(!catalog||!catalog.entries.length)return knowledgeGap(context,'No complete per-branch BTC service settings are enabled. Review the BTC switches, working hours and phone numbers in Branches before directing this customer.');
  const asksAvailability=availabilityQuestion(context.text??'');
  const active=(asksAvailability||currentBranchFollowUp(context.text??'')||serviceDetailFollowUp(context.text??''))?activeBranchRecord(context,sources):null;
  if(active){
    const activeEntries=catalog.entries.filter(entry=>btcBranchRecords(entry,sources).some(source=>source.id===active.id));
    if(activeEntries.length===1)return detailsForEntries(context,catalog,activeEntries,sources,asksAvailability);
    if(asksAvailability||serviceDetailFollowUp(context.text??''))return unavailableAtBranch(context,catalog,active);
  }
  if(contextualRecords.length){
    const contextualEntries=catalog.entries.filter(entry=>btcBranchRecords(entry,sources).some(source=>contextualRecords.includes(source)));
    if(contextualEntries.length)return detailsForEntries(context,catalog,contextualEntries,sources);
  }
  let selected=named;
  if(!selected.length&&requestedRecords.length){
    selected=catalog.entries.filter(e=>btcBranchRecords(e,sources).some(s=>requestedRecords.includes(s)));
    if(!selected.length)return directory(context,catalog,sources,catalog.entries,true);
  }
  if(!selected.length&&scope!=='directory'&&/\b(?:phone|number|address|location|hours|details)\b|رقم|تليفون|عنوان|لوكيشن|مواعيد|تفاصيل/.test(normalizeIntent(context.text??''))){
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user');
    if(previous){const words=new Set(nameWords(previous.content));selected=catalog.entries.filter(e=>meaningful(nameWords(e.name)).every(w=>words.has(w)));}
  }
  // Recover a selection followed by the product clarification (e.g. Korba -> BTC).
  if(!selected.length&&/^(?:btc|bullion|سبائك|السبائك)[.!؟? ]*$/i.test(normalizeIntent(context.text??''))){
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user');
    if(previous){const words=new Set(nameWords(previous.content));selected=catalog.entries.filter(e=>meaningful(nameWords(e.name)).every(w=>words.has(w)));}
  }
  if(selected.length===1)return details(context,catalog,selected[0],sources);
  return directory(context,catalog,sources,selected.length?selected:catalog.entries);
}
