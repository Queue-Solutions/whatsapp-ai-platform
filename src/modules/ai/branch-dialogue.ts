import type {KnowledgeSource,AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
import {branchScope,normalizeIntent,matchingBranches,locationWords} from './branch-scope';
import {replyLanguage} from './language';

export const bullionPattern=/\bbtc\b|\bbullion\b|\bgold bars?\b|سبائك|سبيكه|جنيهات الذهب/;
const jewelryPattern=/\bjewel(?:ry|lery)\b|مجوهرات|مشغولات|الماس|دبل|خواتم/;
export function productIntent(context:MessageContext):'btc'|'jewelry'|null {
  for(const text of [context.text??'',...(context.history??[]).filter(m=>m.role==='user').map(m=>m.content).reverse()]){
    const t=normalizeIntent(text),btc=bullionPattern.test(t),jewelry=jewelryPattern.test(t);
    if(btc&&jewelry)return null;
    if(btc)return 'btc';if(jewelry)return 'jewelry';
  }
  // These exact headings are emitted only after product routing has already been resolved.
  for(const message of [...(context.history??[])].reverse().filter(m=>m.role==='assistant')){
    const assistant=normalizeIntent(message.content);
    if(/(?:^|\n)فروع المجوهرات:|(?:^|\n)jewelry branches:/.test(assistant))return 'jewelry';
    if(/(?:الفروع المتاحه لخدمه btc|for btc \/ bullion, these are the branches offering this service)/.test(assistant))return 'btc';
  }
  return null;
}
export function branchData(source:KnowledgeSource):Record<string,string>|null {
  try{const d=JSON.parse(source.content);return source.kind==='fact'&&d.category==='branch'?d.value:null;}catch{return null;}
}
export const sourceRef=(s:KnowledgeSource)=>({id:s.id,kind:s.kind,updatedAt:s.updatedAt});
export function productQuestion(context:MessageContext):AgentDecision {
  return {action:'clarify',reason:'branch_product_clarification',sources:[],text:replyLanguage(context.text??'')==='ar'
    ?'حضرتك بتسأل عن المجوهرات ولا منتجات BTC والسبائك؟ علشان أوجّهك للفروع المناسبة ومواعيد الخدمة.'
    :'Are you looking for jewelry or BTC / bullion products? I’ll use that to find the right branches and service hours.'};
}
export function isLocationRequest(context:MessageContext,sources:KnowledgeSource[]){
  let t=normalizeIntent(context.text??'');
  if(/^(?:btc|bullion|jewel(?:ry|lery)|سبائك|السبائك|مجوهرات|المجوهرات)[.!؟? ]*$/.test(t)){
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user');
    if(previous)t=normalizeIntent(previous.content);
  }
  if(/\b(?:hours|opening|closing|open|close|payment|pay|cards?|phone|price|sell|buy|offer|services?|delivery|refund|returns?|warranty|parking)\b|مواعيد|ساعات|دفع|سعر|تليفون|بتبيع|بيبيع|متاح|خدمات|استرجاع|استبدال|ركنه/.test(t))return false;
  return branchScope(context,sources)!=='none';
}
export function needsProductQuestion(context:MessageContext,sources:KnowledgeSource[]){
  return sources.some(s=>branchData(s))&&branchScope(context,sources)!=='none'&&!productIntent(context);
}
/** Branch addresses and general hours must not leak into a directory or BTC service answer. */
export function branchSourceContent(context:MessageContext,source:KnowledgeSource,sources:KnowledgeSource[]){
  const value=branchData(source);if(!value)return source.content;
  if(branchScope(context,sources)==='directory'||(productIntent(context)==='btc'&&!isLocationRequest(context,sources))){
    return JSON.stringify({category:'branch',value:{name:value.name,city:value.city??''}});
  }
  if(productIntent(context)==='btc')return JSON.stringify({category:'branch',value:{name:value.name,city:value.city??'',address:value.address,mapsUrl:value.mapsUrl}});
  return source.content;
}
/** Render confirmed record fields, never model-generated addresses or map links. */
export function renderBranchAnswer(context:MessageContext,decision:AgentDecision,sources:KnowledgeSource[]):AgentDecision {
  if(decision.action!=='answer')return decision;
  const scope=branchScope(context,sources),ar=replyLanguage(context.text??'')==='ar';
  const records=sources.filter(s=>branchData(s)&&decision.sources.some(ref=>ref.id===s.id&&ref.kind===s.kind));
  if(scope==='directory'&&productIntent(context)==='jewelry'&&records.length){
    const lines=records.map(s=>{const d=branchData(s)!;return `• ${d.name}${d.city?` — ${d.city}`:''}`;});
    return {...decision,text:`${ar?'فروع المجوهرات:':'Jewelry branches:'}\n\n${lines.join('\n')}\n\n${ar?'اكتب اسم الفرع اللي يناسبك علشان أبعتلك العنوان الكامل ورابط الموقع.':'Type the branch you want for its full address and location link.'}`};
  }
  if(scope==='directory'&&productIntent(context)==='btc'){
    const footer=ar?'اكتب اسم الفرع اللي يناسبك علشان أبعتلك العنوان الكامل ورابط الموقع.':'Type the branch you want for its full address and location link.';
    const intro=ar?'لو بتسأل على السبائك، فدي الفروع المتاحة لخدمة BTC:':'For BTC / bullion, these are the branches offering this service:';
    const body=decision.text.startsWith(intro)?decision.text:`${intro}\n\n${decision.text}`;
    return {...decision,text:body.endsWith(footer)?body:`${body}\n\n${footer}`};
  }
  if(scope==='detail'&&isLocationRequest(context,sources)&&records.length===1){
    const d=branchData(records[0])!;
    if(!d.address?.trim())return decision;
    return {...decision,text:`${d.name}${d.city?` — ${d.city}`:''}\n\n${d.address}\n\n${d.mapsUrl|| (ar?'رابط الموقع مش متاح حالياً للفرع ده.':'A location link is not currently available for this branch.')}`};
  }
  return decision;
}

/** Exact location selection can be answered without waiting for a model or consuming its output budget. */
export function directBranchDetail(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  if(branchScope(context,sources)!=='detail'||!isLocationRequest(context,sources)||productIntent(context)!=='jewelry')return null;
  let matches=matchingBranches(context.text??'',sources);
  if(!matches.length&&/^(?:btc|bullion|jewel(?:ry|lery)|سبائك|السبائك|مجوهرات|المجوهرات)[.!؟? ]*$/i.test(normalizeIntent(context.text??''))) {
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user');
    if(previous)matches=matchingBranches(previous.content,sources);
  }
  if(matches.length!==1||!branchData(matches[0])?.address)return null;
  // A named branch inside a product question is not an address selection.
  const value=branchData(matches[0])!;
  const allowed=new Set([...locationWords(`${value.name} ${value.city??''}`),...locationWords('address location directions branch store the in at to where is are your please send me full and what about do you have is there jewelry jewellery عنوان العنوان موقع الموقع لوكيشن فرع الفرع في فين موجود فيه هل عندكم عندكو عندكوا معندكوش ممكن ابعت ابعتلي مجوهرات المجوهرات')]);
  if(locationWords(context.text??'').some(word=>!allowed.has(word)))return null;
  return renderBranchAnswer(context,{action:'answer',reason:'approved_knowledge',text:'',sources:matches.map(sourceRef)},sources);
}
