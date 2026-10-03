import type {KnowledgeSource,AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
import {branchScope,normalizeIntent,matchingBranches,locationWords} from './branch-scope';
import {replyLanguage} from './language';

export const bullionPattern=/\bbtc\b|\bbullion\b|\bgold (?:bars?|coins?)\b|سبائك|سبيكه|جنيهات? (?:ال)?(?:ذهب|دهب)|جنيه (?:ال)?(?:ذهب|دهب)/;
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
/** Match the stable order shown in the branch menu, preserving input order for legacy/test sources. */
export function orderedBranchSources<T extends KnowledgeSource>(sources:T[]):T[]{
  return sources.map((source,index)=>({source,index})).sort((a,b)=>{
    const first=a.source.branchOrder,second=b.source.branchOrder;
    if(first!=null&&second!=null&&first!==second)return first-second;
    if(first!=null&&second==null)return -1;if(first==null&&second!=null)return 1;
    return a.index-b.index;
  }).map(item=>item.source);
}
export const numberedBranchLines=(lines:string[])=>lines.map((line,index)=>`${lines.length>1?`${index+1}.`:'•'} ${line}`);
const contextualDetailRequest=/\b(?:both|all|them|their|these|those|locations?|addresses?|details?|maps?|links?)\b|(?:الاتنين|الاثنين|كلاهما|كلهم|مواقعهم|عناوينهم|لوكيشن|لوكيشنات|موقع|مواقع|عناوين|تفاصيل)/;
const selectionNumber=(text:string)=>{
  const normalized=text.replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c<='٩'?1632:1776))).trim();
  const match=normalized.match(/^(?:branch\s*|فرع\s*)?(\d{1,2})[.)]?[.!،,؟? ]*$/i);
  return match?Number(match[1]):null;
};
export function branchReplyArabic(context:MessageContext){
  const lastAssistant=[...(context.history??[])].reverse().find(message=>message.role==='assistant')?.content??'';
  return replyLanguage(selectionNumber(context.text??'')!=null&&lastAssistant?lastAssistant:context.text??'')==='ar';
}
/** Resolve plural branch references from the most recent assistant directory. */
export function contextualBranchRecords(context:MessageContext,sources:KnowledgeSource[]){
  const selectedNumber=selectionNumber(context.text??'');
  if(selectedNumber==null&&!contextualDetailRequest.test(normalizeIntent(context.text??'')))return [];
  for(const message of [...(context.history??[])].reverse().filter(item=>item.role==='assistant').slice(0,6)){
    if(selectedNumber!=null){
      const numbered=message.content.split(/\r?\n/).flatMap(line=>{
        const match=line.trim().match(/^(\d{1,2})[.)]\s+(.+)$/);return match?[{number:Number(match[1]),text:match[2]}]:[];
      });
      const chosen=numbered.find(item=>item.number===selectedNumber);
      if(chosen){const records=matchingBranches(chosen.text,sources);if(records.length)return orderedBranchSources(records);}
    }
    const words=new Set(locationWords(message.content));
    const records=sources.filter(source=>{
      const value=branchData(source);if(!value?.name)return false;
      const identity=locationWords(value.name).filter(word=>!['iram','tjh','branch','store','mall','hotel','the','el','al','فرع','الفرع','فندق','مول'].includes(word));
      return identity.length>0&&identity.every(word=>words.has(word));
    });
    if(records.length>1)return orderedBranchSources(records);
  }
  return [];
}
export function productQuestion(context:MessageContext):AgentDecision {
  return {action:'clarify',reason:'branch_product_clarification',sources:[],text:replyLanguage(context.text??'')==='ar'
    ?'أكيد، يسعدني مساعدتك في الوصول إلى الفرع المناسب. هل تبحث عن المجوهرات أم منتجات BTC والسبائك؟'
    :'Of course. I’ll help you find the right branch. Are you looking for jewelry or BTC / bullion products?'};
}
export function isLocationRequest(context:MessageContext,sources:KnowledgeSource[]){
  let t=normalizeIntent(context.text??'');
  if(/^(?:btc|bullion|jewel(?:ry|lery)|سبائك|السبائك|مجوهرات|المجوهرات)[.!؟? ]*$/.test(t)){
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user');
    if(previous)t=normalizeIntent(previous.content);
  }
  if(/\b(?:hours|opening|closing|open|close|payment|pay|cards?|phone|price|sell|buy|offer|services?|delivery|refund|returns?|warranty|parking)\b|مواعيد|ساعات|دفع|سعر|تليفون|بتبيع|بيبيع|متاح|خدمات|استرجاع|استبدال|ركنه/.test(t))return false;
  // Mentioning a branch inside a product-availability question is not a
  // request for that branch's address. Keep the rule grammatical and
  // product-agnostic so it applies to any catalog item, not a fixed SKU list.
  const explicitLocation=/\b(?:where|address|location|directions?|maps?|branches|locations|stores|shops)\b|(?:فين|عنوان|العنوان|موقع|الموقع|لوكيشن|فروع|افرع|اماكن)/.test(t);
  const inventoryQuestion=/\b(?:(?:what|which).{0,45}(?:have|carry|stock|offer|sell)|(?:do|does).{0,35}(?:have|carry|stock|offer|sell)|(?:is|are).{0,35}(?:available|sold))\b|(?:ايه|ما هي|هل).{0,35}(?:عندكم|متوفر|موجود|بتبيع|بيبيع)/.test(t);
  if(inventoryQuestion&&!explicitLocation)return false;
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
  const scope=branchScope(context,sources),ar=branchReplyArabic(context);
  const records=orderedBranchSources(sources.filter(s=>branchData(s)&&decision.sources.some(ref=>ref.id===s.id&&ref.kind===s.kind)));
  if(scope==='directory'&&productIntent(context)==='jewelry'&&records.length){
    const lines=numberedBranchLines(records.map(s=>{const d=branchData(s)!;return `${d.name.trim()}${d.city?.trim()?` — ${d.city.trim()}`:''}`;}));
    return {...decision,text:`${ar?'أكيد، فهمت أنك تبحث عن فروع المجوهرات.\n\nفروع المجوهرات:':'Of course. I understand you’re looking for jewelry branches.\n\nJewelry branches:'}\n\n${lines.join('\n')}\n\n${ar?'اكتب رقم الفرع أو اسمه لعرض العنوان الكامل ورابط الموقع.':'Type the branch number or name to receive its full address and location link.'}`};
  }
  if(scope==='directory'&&productIntent(context)==='btc'){
    const footer=ar?'اكتب رقم الفرع أو اسمه لعرض العنوان الكامل ورابط الموقع.':'Type the branch number or name to receive its full address and location link.';
    const intro=ar?'أكيد، فهمت أنك تبحث عن فروع خدمة BTC والسبائك.\n\nالفروع المتاحة لخدمة BTC والسبائك:':'Of course. I understand you’re looking for BTC / bullion service branches.\n\nBranches offering BTC / bullion services:';
    const body=decision.text.startsWith(intro)?decision.text:`${intro}\n\n${decision.text}`;
    return {...decision,text:body.endsWith(footer)?body:`${body}\n\n${footer}`};
  }
  if(scope==='detail'&&isLocationRequest(context,sources)&&records.length===1){
    const d=branchData(records[0])!;
    if(!d.address?.trim())return decision;
    return {...decision,text:branchDetailText(d,ar)};
  }
  return decision;
}

function branchDetailText(value:Record<string,string>,ar:boolean,acknowledge=true){
  const name=value.name.trim(),city=value.city?.trim(),address=value.address.trim(),mapsUrl=value.mapsUrl?.trim();
  return `${acknowledge?(ar?'أكيد، هذه تفاصيل الفرع المطلوب:\n\n':'Of course. Here are the requested branch details:\n\n'):''}${name}${city?` — ${city}`:''}\n\n${address}\n\n${mapsUrl|| (ar?'رابط الموقع غير متاح لهذا الفرع حاليًا.':'A location link is not currently available for this branch.')}`;
}

/** Complete jewelry directories never depend on the model's knowledge-size selection. */
export function directJewelryDirectory(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  if(branchScope(context,sources)!=='directory'||productIntent(context)!=='jewelry'||matchingBranches(context.text??'',sources).length)return null;
  const records=orderedBranchSources(sources.filter(source=>branchData(source)));
  if(!records.length)return null;
  return renderBranchAnswer(context,{action:'answer',reason:'approved_knowledge',text:'',sources:records.map(sourceRef)},sources);
}

/** Exact branch or area selections can be answered without waiting for a model or consuming its output budget. */
export function directBranchDetail(context:MessageContext,sources:KnowledgeSource[]):AgentDecision|null {
  const scope=branchScope(context,sources);
  if(productIntent(context)!=='jewelry')return null;
  const contextual=contextualBranchRecords(context,sources);
  if(!contextual.length&&(!['detail','directory'].includes(scope)||!isLocationRequest(context,sources)))return null;
  let matches=orderedBranchSources(contextual.length?contextual:matchingBranches(context.text??'',sources));
  if(!matches.length&&/^(?:btc|bullion|jewel(?:ry|lery)|سبائك|السبائك|مجوهرات|المجوهرات)[.!؟? ]*$/i.test(normalizeIntent(context.text??''))) {
    const previous=[...(context.history??[])].reverse().find(m=>m.role==='user');
    if(previous)matches=matchingBranches(previous.content,sources);
  }
  if(!matches.length||matches.some(source=>!branchData(source)?.address?.trim()))return null;
  const values=matches.map(source=>branchData(source)!);
  const decision={action:'answer' as const,reason:'approved_knowledge',text:'',sources:matches.map(sourceRef)};
  if(matches.length===1)return {...decision,text:branchDetailText(values[0],branchReplyArabic(context))};
  const ar=branchReplyArabic(context),blocks=numberedBranchLines(values.map(value=>branchDetailText(value,ar,false)));
  return {...decision,text:`${ar?'أكيد، فهمت أنك تبحث عن فروع المجوهرات في هذه المنطقة. هذه هي الفروع المتاحة:':'Of course. I understand you’re looking for jewelry branches in this area. These are the available branches:'}\n\n${blocks.join('\n\n')}`};
}
