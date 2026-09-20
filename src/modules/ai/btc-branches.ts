import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {branchData,productIntent,sourceRef,bullionPattern} from './branch-dialogue';
import {branchScope,isBranchSource,normalizeIntent,locationWords,matchingBranches} from './branch-scope';
import {replyLanguage} from './language';
import {knowledgeGap} from './knowledge-gap';

interface BtcEntry {name:string;phone:string}
interface BtcCatalog {entries:BtcEntry[];hours:string[];sources:KnowledgeSource[]}
const question8=normalizeIntent('What information can you provide about your bullion or BTC products?');
const digits=(text:string)=>text.replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c<='٩'?1632:1776)));
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
function directory(context:MessageContext,catalog:BtcCatalog,sources:KnowledgeSource[],entries=catalog.entries,unlisted=false):AgentDecision {
  const ar=replyLanguage(context.text??'')==='ar';
  const refs=[...catalog.sources];
  const lines=entries.map(entry=>{
    const records=btcBranchRecords(entry,sources);
    const city=records.length===1?branchData(records[0])?.city:'';
    if(city)refs.push(records[0]);
    return `• ${entry.name}${city?` — ${city}`:''}`;
  });
  const intro=unlisted?(ar?'الفرع ده مش ضمن فروع BTC المؤكدة في المعلومات المتاحة. دي الفروع المدرجة للخدمة:':'That branch is not listed for BTC in the approved information. These branches are listed for the service:')
    :ar?'لو بتسأل على السبائك، فدي الفروع المتاحة لخدمة BTC:':'For BTC / bullion, these are the branches offering this service:';
  const hours=hoursText(catalog.hours,ar);
  return {action:'answer',reason:'approved_knowledge',sources:[...new Map(refs.map(s=>[s.id,s])).values()].map(sourceRef),
    text:[intro,lines.join('\n'),hours,ar?'اكتب اسم الفرع اللي يناسبك علشان أبعتلك العنوان الكامل ورابط الموقع ورقم خدمة BTC.':'Type the branch you want for its full address, location link and BTC phone number.'].filter(Boolean).join('\n\n')};
}
function details(context:MessageContext,catalog:BtcCatalog,entry:BtcEntry,sources:KnowledgeSource[]):AgentDecision {
  const ar=replyLanguage(context.text??'')==='ar',matches=btcBranchRecords(entry,sources);
  const record=matches.length===1?matches[0]:null,data=record?branchData(record):null;
  return {action:'answer',reason:'approved_knowledge',sources:[...catalog.sources,...(record?[record]:[])].map(sourceRef),text:[
    `${entry.name}${data?.city?` — ${data.city}`:''}`,
    data?.address?.trim()||(ar?'العنوان الكامل مش مؤكد عندي للفرع ده حاليًا.':'The full address is not confirmed for this branch right now.'),
    data?.mapsUrl?.trim()||(ar?'رابط الموقع مش متاح حاليًا للفرع ده.':'A location link is not currently available for this branch.'),
    `${ar?'رقم خدمة BTC':'BTC phone'}: ${entry.phone}`,hoursText(catalog.hours,ar),
  ].filter(Boolean).join('\n\n')};
}

/** Directory and branch-detail replies are constructed from source fields; the model cannot add branches or swap phones. */
export function btcBranchReply(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  if(productIntent(context)!=='btc')return null;
  const scope=branchScope(context,sources),catalog=btcCatalog(sources);
  const queryWords=new Set(nameWords(context.text??''));
  const named=catalog?.entries.filter(e=>meaningful(nameWords(e.name)).every(w=>queryWords.has(w)))??[];
  const requestedRecords=matchingBranches(context.text??'',sources);
  const focusedProduct=/\b(?:price|prices|cost|payment|refund|warranty|weight|karat)\b|اسعار|سعر|بكام|دفع|استرجاع|ضمان|عيار|وزن/.test(normalizeIntent(context.text??''));
  if(focusedProduct)return null;
  if(scope==='none'&&!named.length)return null;
  if(!catalog)return knowledgeGap(context,'The approved BTC FAQ does not provide one unambiguous branch-to-BTC-phone list. Review its branch entries before directing this customer.');
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
