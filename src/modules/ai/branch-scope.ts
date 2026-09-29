import type {KnowledgeSource,AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
import {replyLanguage} from './language';
export const normalizeIntent=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[إأآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/سبايك/g,'سبائك');
const focusedDetail=/\b(?:hours|opening|closing|payment|cards?|delivery|prices?|refund|warranty|parking)\b|(?:مواعيد|ساعات|دفع|فيزا|اسعار|سعر|استرجاع|استبدال|ضمان|ركنه)/;
export function isBranchSource(source:KnowledgeSource):boolean {
  try{const data=JSON.parse(source.content);return data.category==='branch'||(source.kind==='faq'&&directScope(String(data.question??''))==='directory');}catch{return false;}
}
function directScope(text:string):'none'|'detail'|'directory'{
  const t=normalizeIntent(text);
  if(/\b(?:don't|do not) (?:show|send|list|want|need).{0,20}(?:branches|locations|addresses)|\bno branch(?:es)?\b|(?:مش عايز|مش عاوز|بلاش|من غير|بدون|متبعتش|لا ترسل).{0,20}(?:فروع|عناوين)/.test(t))return 'none';
  if(/\b(?:branches|locations|stores|shops)\b|(?:فروع|افرع|عناوين|اماكنكم|فينكم)|\bwhere (?:are you|can i find you)\b/.test(t))return focusedDetail.test(t)&&!/(?:\b(?:list|addresses|locations)\b|عناوين|اماكن)/.test(t)?'detail':'directory';
  if(/\b(?:branch|location|address|store|hours|opening|closing|open|close|phone|telephone)\b|(?:الفرع|فرع|عنوان|مواعيد|ساعات العمل|فاتحين|بتفتحوا|بتقفلوا)/.test(t))return 'detail';
  return 'none';
}
export function locationWords(text:string){
  let t=normalizeIntent(text);
  for(const [pattern,replacement] of [
    // Treat regional names as identities, not loose city words. In particular,
    // New Cairo/Fifth Settlement must not collapse to generic "Cairo", which
    // can either miss eligible branches or let an unrelated Cairo branch win.
    [/(?:القاهره|قاهره)\s*الجديده|التجمع(?:\s*الخامس)?|تجمع(?:\s*خامس)?|\bnew\s+cairo\b|\bfifth\s+settlement\b|\b5th\s+settlement\b/g,'newcairo'],
    [/المعادي|المعادى|معادي|معادى|\bmaadi\b/g,'maadi'],
    [/الكربه|كربه|كوربه|كوربا|\bcorba\b|\bkorba\b/g,'korba'],
    [/سيتي\s*ستارز?|سيتى\s*ستارز?|\bcity\s+stars?\b/g,'stars'],
    [/ميفيدا|\bmivida\b/g,'mivida'],
    [/الكوثر|كوثر|\bkawthar\b/g,'kawthar'],
    [/نوكس|نوكي|\bnox\b/g,'nox'],
    [/اركان|\barkan\b/g,'arkan'],
    [/زيا|زايا|\bzia\b/g,'zia'],
    [/كمبنسكي|كمبينسكي|\bkempinski\b/g,'kempinski'],
    [/سنزو|\bsenzo\b/g,'senzo'],
    [/مصر الجديده|هليوبوليس|هليوبلس|هليوبولس|\bheliopolis\b/g,'heliopolis'],
    [/مدينه نصر|مدينة نصر|\bnasr(?: city)?\b/g,'nasr'],
    [/اكتوبر|أكتوبر|\boctober\b/g,'october'],
    [/رشدي|رشدى|\broshdy\b/g,'roshdy'],
    [/الاسكندريه|اسكندريه|alexandria|\balex\b/g,'alexandria'],
    [/الغردقه|غردقه|hurghada/g,'hurghada'],
    [/القاهره|قاهره|cairo/g,'cairo'],
    [/المنصوره|منصوره|mansoura|\bmans\b/g,'mansoura'],
    [/الشيخ زايد|شيخ زايد|sheikh zayed/g,'zayed'],
  ] as const)t=t.replace(pattern,replacement);
  const words=t.match(/[\p{L}\p{N}]+/gu)??[];
  // Canonical regions keep searchable natural-language forms so ordinary
  // misspellings can be compared to the live catalog without maintaining a
  // typo dictionary for each customer phrase.
  return words.flatMap(word=>word==='newcairo'?['newcairo','fifth','settlement','tagamo3']:word);
}
function locationWordClose(value:string,target:string){
  if(value===target)return true;
  if(value[0]!==target[0]||Math.min(value.length,target.length)<4||Math.abs(value.length-target.length)>2)return false;
  const limit=Math.max(value.length,target.length)>=8?2:1;
  let previous=Array.from({length:target.length+1},(_,index)=>index),beforePrevious:number[]|null=null;
  for(let row=1;row<=value.length;row++){
    const current=[row];let minimum=row;
    for(let column=1;column<=target.length;column++){
      current[column]=Math.min(current[column-1]+1,previous[column]+1,previous[column-1]+(value[row-1]===target[column-1]?0:1));
      if(beforePrevious&&row>1&&column>1&&value[row-1]===target[column-2]&&value[row-2]===target[column-1])
        current[column]=Math.min(current[column],beforePrevious[column-2]+1);
      minimum=Math.min(minimum,current[column]);
    }
    if(minimum>limit)return false;
    beforePrevious=previous;previous=current;
  }
  return previous[target.length]<=limit;
}
export function matchingBranches(text:string,sources:KnowledgeSource[]){
  // Arabizi often attaches the Arabic article to a place name (for example,
  // "elmaadi" or "alarkan"). Keep the original token and also compare the
  // article-free form against the live branch catalog rather than maintaining
  // one-off aliases for every location.
  const words=new Set(locationWords(text).flatMap(word=>{
    const articleFree=/^(?:el|al)[\p{L}\p{N}]{3,}$/u.test(word)?word.slice(2):'';
    return articleFree?[word,articleFree]:[word];
  }));
  const scored=sources.map(source=>{try{
    const d=JSON.parse(source.content);
    if(d.category!=='branch')return {source,score:0};
    const nameWords=locationWords(String(d.value?.name??''));
    const cityWords=locationWords(String(d.value?.city??''));
    const addressWords=locationWords(String(d.value?.address??''));
    const meaningful=(word:string)=>word.length>2&&!['iram','ارم','ايرام','branch','mall','btc','tjh','the','city','town','new','مدينه','المدينه','الجديده'].includes(word);
    const matches=(candidates:string[])=>[...new Set(candidates.filter(meaningful))]
      .filter(candidate=>[...words].some(word=>locationWordClose(word,candidate))).length;
    const score=matches(nameWords)*2+matches(cityWords)+matches(addressWords);
    return {source,score};
  }catch{return {source,score:0};}});
  const max=Math.max(0,...scored.map(s=>s.score));
  return max?scored.filter(s=>s.score===max).map(s=>s.source):[];
}
export function nearestIntent(context:MessageContext):boolean {
  const text=normalizeIntent(context.text??'');
  if(/\b(?:nearest|closest|near me|nearby)\b|اقرب|قريب مني|قريبه مني/.test(text)){
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content??'';
    return /\b(?:branch|store|shop|one|btc|bullion)\b|فرع|فروع|واحد|سبائك/.test(text)||/branches|branch|فروع|فرع/i.test(previous);
  }
  return false;
}
const namedBranch=(text:string,sources:KnowledgeSource[])=>matchingBranches(text,sources).length>0;
export function branchScope(context:MessageContext,sources:KnowledgeSource[]=[]):'none'|'detail'|'directory'{
  const text=context.text??'',direct=directScope(text);
  if(nearestIntent(context)||context.type==='location')return 'detail';
  if(direct!=='none')return direct==='detail'&&!focusedDetail.test(normalizeIntent(text))&&matchingBranches(text,sources).length>1?'directory':direct;
  if(namedBranch(text,sources)){
    const matches=matchingBranches(text,sources);
    return matches.length>1?'directory':'detail';
  }
  const lastAssistant=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content??'';
  if(/^(?:btc|bullion|jewel(?:ry|lery)|سبائك|السبائك|مجوهرات|المجوهرات)[.!؟? ]*$/i.test(normalizeIntent(text).trim())&&/(?:فرع|فروع|branches|jewelry|مجوهرات)/i.test(lastAssistant)){
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user');
    return previous&&namedBranch(previous.content,sources)?branchScope({...context,text:previous.content,history:[]},sources):'directory';
  }
  if(/\bbtc\b|\bbullion\b|سبائك|سبيكه/.test(normalizeIntent(text)))return focusedDetail.test(normalizeIntent(text))?'detail':'directory';
  // Only immediate, short continuations inherit branch context. An unrelated new topic does not.
  if(text.length<100&&/^(?:and\b|what about\b|also\b|yes\b|sure\b|و|طيب|اه[.!؟? ]*$|ايوه|يوم|تمام[.!؟? ]*$)/i.test(normalizeIntent(text))){
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user')?.content??'';
    if(directScope(previous)!=='none'||namedBranch(previous,sources))return 'detail';
  }
  return 'none';
}
/** Enforce scope even if the model ignores the prompt or puts a directory in prose. */
export function unsolicitedBranches(context:MessageContext,decision:Pick<AgentDecision,'text'|'sources'>,available:KnowledgeSource[],lines:string[]=[]){
  const scope=branchScope(context,available);if(scope==='directory')return false;
  const branchSources=available.filter(isBranchSource);
  const cited=branchSources.filter(s=>decision.sources.some(ref=>ref.id===s.id&&ref.kind===s.kind));
  const named=branchSources.filter(s=>{try{const d=JSON.parse(s.content);const name=String(d.value?.name??'');const address=String(d.value?.address??'');const text=normalizeIntent(decision.text);return [name,address].some(v=>v.length>4&&text.includes(normalizeIntent(v)));}catch{return false;}});
  return scope==='none'?(lines.length>0||cited.length>0||named.length>0):(lines.length>1||named.length>1||(cited.length>1&&decision.text.length>500));
}
export function scopeClarification(context:MessageContext):AgentDecision {
  const ar=replyLanguage(context.text??'')==='ar',branchRelated=branchScope(context)==='detail';
  return {action:'clarify',reason:'reply_scope_clarification',sources:[],text:branchRelated
    ? ar?'فهمت أنك تسأل عن أحد الفروع. تقصد أي فرع؟ اكتب اسم الفرع أو المنطقة وسأساعدك مباشرة.':'I understand you’re asking about a branch. Which one do you mean? Share its name or area and I’ll help directly.'
    : ar?'يسعدني مساعدتك. هل استفسارك عن المجوهرات، أو منتجات BTC والسبائك، أو الفروع، أو خدمة أخرى من IRAM؟':'I’ll be happy to help. Is your enquiry about jewelry, BTC / bullion, branches, or another IRAM service?'};
}
