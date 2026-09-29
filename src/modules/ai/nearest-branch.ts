import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {branchData,productIntent,productQuestion,sourceRef} from './branch-dialogue';
import {btcCatalog,btcBranchRecords} from './btc-branches';
import {nearestIntent,normalizeIntent,locationWords,matchingBranches} from './branch-scope';
import {distanceKm,point,coordinates,type LocationResolver} from './branch-location';
import {replyLanguage} from './language';
import {knowledgeGap} from './knowledge-gap';
import {continuesRepairService,repairBranchCatalog,repairBranchRecords} from './repair-faq';

const areaPrompt=/which city or area|tell me your current city or area|share (?:your |a )?(?:whatsapp location|google maps pin)|couldn.t identify (?:that|the) area|انت في انهي مدينه|ابعت.*(?:لوكيشن|موقعك)|لم [اأ]تمكن من تحديد (?:هذه|هذة|تلك)?\s*(?:المنطقه|المنطقة|الموقع)/i;
const productOnly=/^(?:btc|bullion|jewel(?:ry|lery)|سبائك|السبائك|مجوهرات|المجوهرات)[.!؟? ]*$/i;
export interface SemanticOrigin {evidence:string;query:string}
function areaAnswer(text:string){return text.length<=120&&!/\?|؟|\b(?:price|cost|buy|refund|hours|job|thanks|yes|no|what|how)\b|سعر|بكام|اشتري|استرجاع|مواعيد|وظيفه|شكرا/.test(normalizeIntent(text));}
function cleanArea(value:string){
  let result=value.trim();
  // Remove conversational corrections without weakening the geocoder's exact
  // place-name validation. The remaining value still has to resolve to one
  // unambiguous city/area before any distance is calculated.
  result=result.replace(/^(?:no|nope)\b[\s,!:;-]*/i,'')
    .replace(/^(?:told\s+(?:u|you)|i\s+(?:already\s+)?(?:said|told\s+you)|as\s+i\s+said|it(?:'s|\s+is)|the\s+(?:city|area)\s+is|my\s+(?:city|area)\s+is)\b[\s,!:;-]*/i,'')
    .replace(/^(?:لا|لأ)\b[\s،,:!؛-]*/,'')
    .replace(/^(?:ما\s+انا\s+)?(?:قلتلك|قولتلك|قلت\s+لك|قولت\s+لك|زي\s+ما\s+قلتلك|انا\s+قلتلك)[\s،,:!؛-]*/,'')
    .replace(/\s+(?:right\s+now|currently|today|now|دلوقتي|دلوقت|حاليا|حالياً|الان|الآن)$/i,'')
    .replace(/^[\s"'“”‘’([{]+|[\s"'“”‘’\])}.،,!?؟:;؛-]+$/g,'').trim();
  return /^(?:me|here|مني|هنا)$/i.test(result)?'':result;
}
function inlineArea(text:string){
  const english=text.match(/\b(?:(?:i(?:'m|\s+am)\s+)?(?:located\s+)?(?:in|from|at|near|around)|close\s+to)\s+(.+?)(?=\s+(?:what|which|where|who|how|would|could|can|should|and\s+i|so\s+i)\b|[?؟!]|$)/i);
  const arabic=text.match(/(?:^|\s)(?:(?:انا|اني)\s+)?(?:في|من|عند|قريب\s+من|جنب)\s+(.+?)(?=\s+(?:ايه|فين|ازاي|ازاى|اقرب|أقرب|عايز|عاوز|محتاج|ممكن)\b|[?؟!]|$)/i);
  const arabicDestination=text.match(/(?:^|\s)لل\s*(.+?)(?=\s+(?:ايه|فين|ازاي|ازاى|اقرب|أقرب|عايز|عاوز|محتاج|ممكن)\b|[?؟!]|$)/i);
  return cleanArea(english?.[1]??arabic?.[1]??arabicDestination?.[1]??'');
}
function areaReply(text:string){
  return inlineArea(text)||cleanArea(text);
}
function normalizedEvidence(value:string){
  return value.normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي')
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
function editDistanceWithin(value:string,target:string,limit:number){
  if(value===target)return true;
  if(Math.abs(value.length-target.length)>limit)return false;
  let previous=Array.from({length:target.length+1},(_,index)=>index);
  for(let row=1;row<=value.length;row++){
    const current=[row];let minimum=row;
    for(let column=1;column<=target.length;column++){
      current[column]=Math.min(current[column-1]+1,previous[column]+1,previous[column-1]+(value[row-1]===target[column-1]?0:1));
      minimum=Math.min(minimum,current[column]);
    }
    if(minimum>limit)return false;
    previous=current;
  }
  return previous[target.length]<=limit;
}
function groundedSemanticOrigin(message:string,hint?:SemanticOrigin|null){
  if(!hint?.evidence.trim()||!hint.query.trim()||hint.evidence.length>160||hint.query.length>120)return '';
  const messageKey=normalizedEvidence(message),evidenceKey=normalizedEvidence(hint.evidence),queryKey=normalizedEvidence(hint.query);
  if(!evidenceKey||!queryKey||!messageKey.includes(evidenceKey)||!/\p{L}/u.test(queryKey))return '';
  if(/https?:|geo:|@|[-+]?\d+\.\d+\s*,/i.test(hint.query))return '';
  const comparable=(value:string)=>value.replace(/\b(?:city|town|district|of|the|al|el)\b|مدينه|مدينة|منطقة|المنطقه|المنطقة/g,'').replace(/\s+/g,'');
  const evidence=comparable(evidenceKey),query=comparable(queryKey),limit=Math.max(2,Math.floor(Math.max(evidence.length,query.length)*.25));
  return evidence&&query&&editDistanceWithin(evidence,query,limit)?hint.query.trim():'';
}
function approvedAreaOrigin(query:string,mapped:Array<{source:KnowledgeSource;position:{latitude:number;longitude:number}}>){
  const noise=new Set(['city','town','district','area','new','the','in','at','مدينه','المدينه','منطقه','المنطقه','الجديده']);
  const wanted=[...new Set(locationWords(query).filter(word=>word.length>2&&!noise.has(word)))];
  if(!wanted.length)return null;
  const matches=mapped.filter(entry=>{
    const data=branchData(entry.source);
    if(!data)return false;
    const words=new Set(locationWords(`${data.name} ${data.city??''} ${data.address??''}`));
    return wanted.every(word=>words.has(word));
  });
  if(!matches.length)return null;
  return {label:query,latitude:matches.reduce((sum,entry)=>sum+entry.position.latitude,0)/matches.length,
    longitude:matches.reduce((sum,entry)=>sum+entry.position.longitude,0)/matches.length};
}
/** True only when the current message answers a nearest-branch question already asked by the assistant. */
export function continuesNearestBranch(context:MessageContext){
  const text=context.text??'',history=context.history??[];
  const lastAssistant=[...history].reverse().find(m=>m.role==='assistant')?.content??'';
  const previousUser=[...history].reverse().find(m=>m.role==='user')?.content??'';
  const answeringArea=areaPrompt.test(lastAssistant)&&(areaAnswer(text)||!!coordinates(text)||/^https:\/\//.test(text));
  const answeringProduct=productOnly.test(normalizeIntent(text).trim())&&/jewelry|مجوهرات/i.test(lastAssistant)
    &&(nearestIntent({...context,text:previousUser,history:history.slice(0,-2)})||previousUser.startsWith('geo:'));
  return answeringArea||answeringProduct||(continuesRepairService(context)&&nearestIntent(context));
}
/** Intercept proximity requests before keyword branch matching or model generation. */
export async function nearestBranchReply(context:MessageContext,sources:KnowledgeSource[],locations:LocationResolver,productHint?:'btc'|'jewelry'|null,originHint?:SemanticOrigin|null):Promise<AgentDecision|null>{
  const text=context.text??'',history=context.history??[];
  const lastAssistant=[...history].reverse().find(m=>m.role==='assistant')?.content??'';
  const previousUser=[...history].reverse().find(m=>m.role==='user')?.content??'';
  const answeringArea=areaPrompt.test(lastAssistant)&&(areaAnswer(text)||!!coordinates(text)||/^https:\/\//.test(text));
  const answeringProduct=productOnly.test(normalizeIntent(text).trim())&&/jewelry|مجوهرات/i.test(lastAssistant)
    &&(nearestIntent({...context,text:previousUser,history:history.slice(0,-2)})||previousUser.startsWith('geo:'));
  if(!nearestIntent(context)&&context.type!=='location'&&!answeringArea&&!answeringProduct)return null;
  const repairContext=continuesRepairService(context);
  const product=productHint??(repairContext?'jewelry':productIntent(context));if(!product)return productQuestion(context);
  const languageText=(context.type==='location'||!!coordinates(text))?[...history].reverse().find(m=>m.role==='user'&&!m.content.startsWith('geo:'))?.content??'':text;
  const ar=replyLanguage(languageText)==='ar';
  const clarify=(value:string):AgentDecision=>({action:'clarify',reason:'nearest_branch_location',text:value,sources:[]});
  const semantic=context.type==='location'||coordinates(text)||/^https:\/\//.test(text)?'':groundedSemanticOrigin(text,originHint);
  let query=context.type==='location'
    ?text
    :(semantic||answeringArea)
      ?semantic||areaReply(text)
      :inlineArea(answeringProduct?previousUser:text);
  if(answeringProduct&&previousUser.startsWith('geo:'))query=previousUser;
  if(!query){
    const known=history.slice(-4).filter(m=>m.role==='user').reverse().find(m=>/^(?:i(?:'m| am)|انا)\s+(?:in|from|في|من)\s+/i.test(m.content));
    if(known)query=inlineArea(known.content);
  }
  if(!query)return clarify(ar
    ?`في أي مدينة أو منطقة تتواجد؟ يمكنك أيضًا إرسال موقعك عبر واتساب أو رابط دبوس Google Maps لتحديد أقرب فرع ${product==='btc'?'لخدمة BTC':'للمجوهرات'}.`
    :`Which city or area are you in? Or share your WhatsApp location or a Google Maps pin so I can find a nearby ${product==='btc'?'BTC':'jewelry'} branch.`);
  query=query.replace(/^(?:i(?:'m| am)|انا)\s+(?:in|from|في|من)\s+/i,'').trim();
  const btc=product==='btc'?btcCatalog(sources):null;
  if(product==='btc'&&!btc)return knowledgeGap(context,'The approved BTC FAQ does not confirm an unambiguous eligible branch list.');
  const repair=product==='jewelry'&&repairContext?repairBranchCatalog(sources):null;
  if(product==='jewelry'&&repairContext&&!repair)return knowledgeGap(context,'The approved maintenance FAQ does not confirm one unambiguous eligible branch list.');
  const repairMatches=repair?.entries.map(entry=>({entry,matches:repairBranchRecords(entry,sources)}))??[];
  if(repairMatches.some(match=>match.matches.length!==1))return knowledgeGap(context,'Every approved maintenance branch must match exactly one saved branch record before comparing distances.');
  const expected=btc?btc.entries.length:repair?repair.entries.length:sources.filter(s=>branchData(s)).length;
  const candidates=btc?btc.entries.flatMap(e=>{const matches=btcBranchRecords(e,sources);return matches.length===1?[{source:matches[0],name:e.name}]:[];})
    :repair?repairMatches.map(({entry,matches})=>({source:matches[0],name:branchData(matches[0])?.name??entry.name}))
      :sources.filter(s=>branchData(s)).map(source=>({source,name:branchData(source)!.name}));
  if(!expected)return knowledgeGap(context,'No approved branch records are available for a location comparison.');
  // A named area that already contains eligible branches is more useful than a
  // global top-three distance list. Return every eligible branch registered in
  // that area, including equivalent names such as Tagamo3, Fifth Settlement and
  // New Cairo, before falling back to geographic ranking.
  const areaMatches=context.type==='location'||coordinates(query)||/^https:\/\//.test(query)
    ?[]:matchingBranches(query,candidates.map(candidate=>candidate.source));
  if(areaMatches.length>1){
    const matchedIds=new Set(areaMatches.map(source=>source.id));
    const inArea=candidates.filter(candidate=>matchedIds.has(candidate.source.id));
    const serviceSources=[...(btc?.sources??[]),...(repair?.sources??[])];
    const intro=product==='btc'
      ?ar?`بالنسبة لمنطقة ${query}، فروع خدمة BTC والسبائك المسجلة فيها هي:`:`For ${query}, these are the registered BTC / bullion service branches:`
      :repair
        ?ar?`بالنسبة لمنطقة ${query}، فروع الصيانة والعناية الفنية المسجلة فيها هي:`:`For ${query}, these are the registered maintenance branches:`
        :ar?`بالنسبة لمنطقة ${query}، فروع المجوهرات المسجلة فيها هي:`:`For ${query}, these are the registered jewelry branches:`;
    const lines=inArea.map(candidate=>{const data=branchData(candidate.source);return `• ${candidate.name}${data?.city?` — ${data.city}`:''}`;});
    const footer=ar?'اكتب اسم الفرع المطلوب لعرض العنوان الكامل ورابط الموقع'+(product==='btc'?' ورقم خدمة BTC.':'.')
      :'Type a branch name to receive its full address and location link'+(product==='btc'?' and BTC phone number.':'.');
    return {action:'answer',reason:'approved_knowledge',sources:[...new Map([...serviceSources,...inArea.map(candidate=>candidate.source)].map(source=>[source.id,source])).values()].map(sourceRef),
      text:[intro,lines.join('\n'),footer].join('\n\n')};
  }
  // Bound outbound map lookups; missing/unmatched records remain part of the coverage check.
  const located=await Promise.all(candidates.slice(0,32).map(async entry=>{
    const data=branchData(entry.source)!;
    const position=point(data.latitude,data.longitude)??await locations.pin(data.mapsUrl??'');
    return position?{...entry,position}:null;
  }));
  const mapped=located.filter((v):v is NonNullable<typeof v>=>v!==null);
  const serviceSources=[...(btc?.sources??[]),...(repair?.sources??[])];
  if(!mapped.length)return {action:'answer',reason:'approved_knowledge',sources:[...serviceSources,...candidates.slice(0,32).map(c=>c.source)].map(sourceRef),text:ar
    ?'فهمت أنك تبحث عن أقرب فرع. إحداثيات الفروع الدقيقة غير متاحة للمقارنة حاليًا، لذلك لا يمكنني تحديد الفرع الأقرب بدقة. اكتب اسم الفرع المطلوب لعرض عنوانه ورابط الموقع المتاح.'
    :'I understand you’re looking for the nearest branch. I don’t have confirmed branch coordinates to compare right now. Type a branch name and I can send its saved address and available location link.'};
  const pin=await locations.pin(query);
  const approvedArea=pin?null:approvedAreaOrigin(query,mapped);
  const externalArea=pin||approvedArea?null:await locations.area(query,mapped.map(m=>m.position));
  const area=approvedArea??externalArea;
  const origin=pin??area;
  if(!origin)return clarify(ar?'فهمت أنك تريد معرفة الفرع الأقرب، لكن لم أتمكن من تحديد هذه المنطقة بشكل مؤكد. يرجى إرسال موقعك عبر واتساب أو رابط دبوس Google Maps لمقارنة المسافات.'
    :'I understand you want the nearest branch, but I couldn’t identify that area unambiguously. Please share your WhatsApp location or a Google Maps pin so I can compare distances.');
  const ranked=mapped.map(m=>({...m,distance:distanceKm(origin,m.position)})).sort((a,b)=>a.distance-b.distance||a.name.localeCompare(b.name));
  const shown=ranked.slice(0,3),complete=mapped.length===expected;
  const serviceName=repair?(ar?'للصيانة والعناية الفنية':'maintenance'):product==='btc'?'BTC':ar?'للمجوهرات':'jewelry';
  const intro=ar?`أكيد، فهمت أنك تبحث عن أقرب خيار ${serviceName}. هذه أقرب الخيارات حسب المسافة المباشرة${area?' من مركز المنطقة تقريبًا':''}:`
    :`Of course. I understand you’re looking for the nearest ${serviceName} option. These are the closest options by straight-line distance${area?' from the approximate area centre':''}:`;
  const caveat=ar?'هذه مسافات مباشرة، وليست مسافات قيادة أو أوقات وصول.':'These are straight-line distances, not driving distances or travel times.';
  const coverage=complete?'':ar?'تشمل المقارنة الفروع ذات المواقع المؤكدة فقط. قد يوجد فرع أقرب ضمن الفروع التي لا تتوفر إحداثياتها.'
    :'This comparison includes only branches with confirmed coordinates. A branch with missing location data could be closer.';
  const lines=shown.map(m=>`• ${m.name}${branchData(m.source)?.city?` — ${branchData(m.source)!.city}`:''} — ${m.distance.toFixed(1)} ${ar?'كم':'km'}`);
  return {action:'answer',reason:'approved_knowledge',sources:[...new Map([...serviceSources,...candidates.slice(0,32).map(c=>c.source)].map(s=>[s.id,s])).values()].map(sourceRef),text:[intro,lines.join('\n'),caveat,coverage,
    ar?'اكتب اسم الفرع المطلوب لعرض العنوان الكامل ورابط الموقع'+(product==='btc'?' ورقم خدمة BTC.':'.')
      :'Type a branch name to receive its full address and location link'+(product==='btc'?' and BTC phone number.':'.'),
    externalArea?(ar?'بيانات المنطقة: © OpenStreetMap contributors':'Area data: © OpenStreetMap contributors'):'',
  ].filter(Boolean).join('\n\n')};
}
