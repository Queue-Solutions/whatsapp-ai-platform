import type {AgentDecision,KnowledgeSource} from './contracts';
import type {MessageContext} from '../messaging/types';
import {branchData,productIntent,productQuestion,sourceRef} from './branch-dialogue';
import {btcCatalog,btcBranchRecords} from './btc-branches';
import {nearestIntent,normalizeIntent} from './branch-scope';
import {distanceKm,point,coordinates,type LocationResolver} from './branch-location';
import {replyLanguage} from './language';
import {knowledgeGap} from './knowledge-gap';

const areaPrompt=/which city or area|tell me your current city or area|share (?:your |a )?(?:whatsapp location|google maps pin)|انت في انهي مدينه|ابعت.*(?:لوكيشن|موقعك)/i;
const productOnly=/^(?:btc|bullion|jewel(?:ry|lery)|سبائك|السبائك|مجوهرات|المجوهرات)[.!؟? ]*$/i;
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
    .replace(/^[\s"'“”‘’([{]+|[\s"'“”‘’\])}.،,!?؟:;؛-]+$/g,'').trim();
  return /^(?:me|here|مني|هنا)$/i.test(result)?'':result;
}
function inlineArea(text:string){
  const english=text.match(/\b(?:(?:i(?:'m|\s+am)\s+)?(?:located\s+)?(?:in|from|at|near|around)|close\s+to)\s+(.+?)(?=\s+(?:what|which|where|who|how|would|could|can|should|and\s+i|so\s+i)\b|[?؟!]|$)/i);
  const arabic=text.match(/(?:^|\s)(?:(?:انا|اني)\s+)?(?:في|من|عند|قريب\s+من|جنب)\s+(.+?)(?=\s+(?:ايه|فين|ازاي|ازاى|اقرب|أقرب|عايز|عاوز|محتاج|ممكن)\b|[?؟!]|$)/i);
  return cleanArea(english?.[1]??arabic?.[1]??'');
}
function areaReply(text:string){
  return inlineArea(text)||cleanArea(text);
}
/** Intercept proximity requests before keyword branch matching or model generation. */
export async function nearestBranchReply(context:MessageContext,sources:KnowledgeSource[],locations:LocationResolver,productHint?:'btc'|'jewelry'|null):Promise<AgentDecision|null>{
  const text=context.text??'',history=context.history??[];
  const lastAssistant=[...history].reverse().find(m=>m.role==='assistant')?.content??'';
  const previousUser=[...history].reverse().find(m=>m.role==='user')?.content??'';
  const answeringArea=areaPrompt.test(lastAssistant)&&(areaAnswer(text)||!!coordinates(text)||/^https:\/\//.test(text));
  const answeringProduct=productOnly.test(normalizeIntent(text).trim())&&/jewelry|مجوهرات/i.test(lastAssistant)
    &&(nearestIntent({...context,text:previousUser,history:history.slice(0,-2)})||previousUser.startsWith('geo:'));
  if(!nearestIntent(context)&&context.type!=='location'&&!answeringArea&&!answeringProduct)return null;
  const product=productHint??productIntent(context);if(!product)return productQuestion(context);
  const languageText=(context.type==='location'||!!coordinates(text))?[...history].reverse().find(m=>m.role==='user'&&!m.content.startsWith('geo:'))?.content??'':text;
  const ar=replyLanguage(languageText)==='ar';
  const clarify=(value:string):AgentDecision=>({action:'clarify',reason:'nearest_branch_location',text:value,sources:[]});
  let query=context.type==='location'?text:answeringArea?areaReply(text):inlineArea(answeringProduct?previousUser:text);
  if(answeringProduct&&previousUser.startsWith('geo:'))query=previousUser;
  if(!query){
    const known=history.slice(-4).filter(m=>m.role==='user').reverse().find(m=>/^(?:i(?:'m| am)|انا)\s+(?:in|from|في|من)\s+/i.test(m.content));
    if(known)query=inlineArea(known.content);
  }
  if(!query)return clarify(ar
    ?`انت في انهي مدينة أو منطقة؟ أو ابعت لوكيشن واتساب أو رابط دبوس Google Maps علشان أحدد أقرب فرع ${product==='btc'?'لخدمة BTC':'للمجوهرات'}.`
    :`Which city or area are you in? Or share your WhatsApp location or a Google Maps pin so I can find a nearby ${product==='btc'?'BTC':'jewelry'} branch.`);
  query=query.replace(/^(?:i(?:'m| am)|انا)\s+(?:in|from|في|من)\s+/i,'').trim();
  const catalog=product==='btc'?btcCatalog(sources):null;
  if(product==='btc'&&!catalog)return knowledgeGap(context,'The approved BTC FAQ does not confirm an unambiguous eligible branch list.');
  const expected=catalog?catalog.entries.length:sources.filter(s=>branchData(s)).length;
  const candidates=catalog?catalog.entries.flatMap(e=>{const matches=btcBranchRecords(e,sources);return matches.length===1?[{source:matches[0],name:e.name}]:[];})
    :sources.filter(s=>branchData(s)).map(source=>({source,name:branchData(source)!.name}));
  if(!expected)return knowledgeGap(context,'No approved branch records are available for a location comparison.');
  // Bound outbound map lookups; missing/unmatched records remain part of the coverage check.
  const located=await Promise.all(candidates.slice(0,32).map(async entry=>{
    const data=branchData(entry.source)!;
    const position=point(data.latitude,data.longitude)??await locations.pin(data.mapsUrl??'');
    return position?{...entry,position}:null;
  }));
  const mapped=located.filter((v):v is NonNullable<typeof v>=>v!==null);
  if(!mapped.length)return {action:'answer',reason:'approved_knowledge',sources:[...(catalog?.sources??[]),...candidates.slice(0,32).map(c=>c.source)].map(sourceRef),text:ar
    ?'مواقع الفروع الدقيقة مش متاحة عندي للمقارنة حاليًا، فمش هقدر أحدد الأقرب بدقة. اكتب اسم الفرع اللي يناسبك علشان أبعتلك عنوانه ورابطه المتاح.'
    :'I don’t have confirmed branch coordinates to compare right now. Type a branch name and I can send its saved address and available location link.'};
  const pin=await locations.pin(query);
  const area=pin?null:await locations.area(query,mapped.map(m=>m.position));
  const origin=pin??area;
  if(!origin)return clarify(ar?'مش قادر أحدد المنطقة دي بشكل مؤكد. ابعت لوكيشن واتساب أو رابط دبوس Google Maps علشان أقارن المسافات.'
    :'I couldn’t identify that area unambiguously. Please share your WhatsApp location or a Google Maps pin so I can compare distances.');
  const ranked=mapped.map(m=>({...m,distance:distanceKm(origin,m.position)})).sort((a,b)=>a.distance-b.distance||a.name.localeCompare(b.name));
  const shown=ranked.slice(0,3),complete=mapped.length===expected;
  const intro=ar?`أقرب الخيارات ${product==='btc'?'لخدمة BTC':'للمجوهرات'} حسب المسافة المباشرة${area?' من مركز المنطقة تقريبًا':''}:`
    :`Closest ${product==='btc'?'BTC':'jewelry'} options by straight-line distance${area?' from the approximate area centre':''}:`;
  const caveat=ar?'دي مسافات مباشرة، مش مسافات أو وقت قيادة.':'These are straight-line distances, not driving distances or travel times.';
  const coverage=complete?'':ar?'المقارنة تشمل الفروع اللي موقعها مؤكد فقط. ممكن يكون فيه فرع أقرب من الفروع اللي موقعها غير متاح.'
    :'This comparison includes only branches with confirmed coordinates. A branch with missing location data could be closer.';
  const lines=shown.map(m=>`• ${m.name}${branchData(m.source)?.city?` — ${branchData(m.source)!.city}`:''} — ${m.distance.toFixed(1)} ${ar?'كم':'km'}`);
  return {action:'answer',reason:'approved_knowledge',sources:[...new Map([...(catalog?.sources??[]),...candidates.slice(0,32).map(c=>c.source)].map(s=>[s.id,s])).values()].map(sourceRef),text:[intro,lines.join('\n'),caveat,coverage,
    ar?'اكتب اسم الفرع اللي يناسبك علشان أبعتلك العنوان الكامل ورابط الموقع'+(product==='btc'?' ورقم خدمة BTC.':'.')
      :'Type a branch name for its full address, location link'+(product==='btc'?' and BTC phone number.':'.'),
    area?(ar?'بيانات المنطقة: © OpenStreetMap contributors':'Area data: © OpenStreetMap contributors'):'',
  ].filter(Boolean).join('\n\n')};
}
