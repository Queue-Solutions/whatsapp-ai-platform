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
    [/المعادي|المعادى|معادي|معادى|\bmaadi\b/g,'maadi'],
    [/كوربه|كوربا|\bcorba\b|\bkorba\b/g,'korba'],
    [/سيتي\s*ستارز?|سيتى\s*ستارز?|\bcity\s+stars?\b/g,'stars'],
    [/ميفيدا|\bmivida\b/g,'mivida'],
    [/الكوثر|كوثر|\bkawthar\b/g,'kawthar'],
    [/نوكس|نوكي|\bnox\b/g,'nox'],
    [/اركان|\barkan\b/g,'arkan'],
    [/زيا|زايا|\bzia\b/g,'zia'],
    [/كمبنسكي|كمبينسكي|\bkempinski\b/g,'kempinski'],
    [/سنزو|\bsenzo\b/g,'senzo'],
    [/التجمع(?: الخامس)?|تجمع(?: خامس)?/g,'cairo'],
    [/مصر الجديده|\bheliopolis\b/g,'heliopolis'],
    [/مدينه نصر|مدينة نصر|\bnasr(?: city)?\b/g,'nasr'],
    [/اكتوبر|أكتوبر|\boctober\b/g,'october'],
    [/رشدي|رشدى|\broshdy\b/g,'roshdy'],
    [/الاسكندريه|اسكندريه|alexandria|\balex\b/g,'alexandria'],
    [/الغردقه|غردقه|hurghada/g,'hurghada'],
    [/القاهره|قاهره|cairo/g,'cairo'],
    [/المنصوره|منصوره|mansoura|\bmans\b/g,'mansoura'],
    [/الشيخ زايد|شيخ زايد|sheikh zayed/g,'zayed'],
  ] as const)t=t.replace(pattern,replacement);
  return t.match(/[\p{L}\p{N}]+/gu)??[];
}
export function matchingBranches(text:string,sources:KnowledgeSource[]){
  const words=new Set(locationWords(text));
  const scored=sources.map(source=>{try{
    const d=JSON.parse(source.content);
    if(d.category!=='branch')return {source,score:0};
    const nameWords=locationWords(String(d.value?.name??''));
    const cityWords=locationWords(String(d.value?.city??''));
    const meaningful=(word:string)=>word.length>2&&!['iram','ارم','ايرام','branch','mall','btc','tjh','the','city','town','new','مدينه','المدينه','الجديده'].includes(word);
    const score=[...new Set(nameWords.filter(meaningful))].filter(w=>words.has(w)).length*2
      +[...new Set(cityWords.filter(meaningful))].filter(w=>words.has(w)).length;
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
  return {action:'clarify',reason:'reply_scope_clarification',sources:[],text:replyLanguage(context.text??'')==='ar'
    ?'ممكن توضح طلبك في سطر واحد علشان أساعدك مباشرة؟'
    :'Could you clarify your request in one sentence so I can help you directly?'};
}
