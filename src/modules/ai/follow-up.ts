import type {AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
import {normalizeIntent} from './branch-scope';
import {replyLanguage} from './language';

export interface FollowUpDetails {state:'collecting'|'ready'|'declined';name:string|null;phone:string|null;purpose?:'career';role?:string|null}
export interface FollowUpContext extends FollowUpDetails {reason:string;summary:string}
const digits=(text:string)=>text.replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c<='٩'?1632:1776)));
const labelledPhone=/(?:phone|contact number|call me|رقمي|تليفوني|رقم (?:التليفون|الموبايل|الهاتف|التواصل))/i;
export function contactPhone(text:string):string|null {
  const candidates=digits(text).match(/(?:\+|00)?\d[\d ()-]{5,}\d/g)??[];
  if(candidates.length!==1)return null;
  let phone=candidates[0].replace(/\D/g,'');
  if(phone.startsWith('00'))phone=phone.slice(2);
  if(/^01[0125]\d{8}$/.test(phone))phone='20'+phone.slice(1);
  return /^[1-9]\d{6,14}$/.test(phone)?phone:null;
}
function contactName(text:string,allowPlain:boolean):string|null {
  const explicit=text.match(/(?:my name is|name\s*:|اسمي|إسمي|الاسم\s*:)\s*([\p{L}\p{M}][\p{L}\p{M}'’ -]{1,79})/iu)?.[1];
  const candidate=(explicit??(allowPlain?text.replace(/(?:\+|00)?[\d٠-٩۰-۹][\d٠-٩۰-۹ ()-]{5,}[\d٠-٩۰-۹]/g,'').replace(/[,،\n]/g,' ').trim():''))
    .replace(/\s+(?:and|phone|number|رقمي|ورقمي|رقم|تليفوني).*$/iu,'').trim();
  if(!/^[\p{L}\p{M}][\p{L}\p{M}'’ -]{1,79}$/u.test(candidate)||candidate.split(/\s+/).length>5)return null;
  if(/\b(?:hi|hello|thanks|no|yes|branches|branch|price|where|when|what|how|please|help|online|website|links?|send|sure|jewelry|bullion|btc|don't|not)\b|(?:فروع|سعر|فين|امتي|متى|ازاي|شكرا|اهلا|عايز|عاوز|مش|رقم|تمام|اون ?لاين|ابعت|ياريت|يا ريت|ماشي|ايوه|روابط|موقع|سبائك|سبايك|مجوهرات|الاسكندريه|الاسكندرية|الغردقه|الغردقة)/iu.test(candidate))return null;
  return candidate;
}
function reply(context:MessageContext,reason:string,summary:string,details:FollowUpDetails):AgentDecision {
  const lastAssistant=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content;
  const ar=replyLanguage(context.followUp?.state==='collecting'&&lastAssistant?lastAssistant:context.text??'')==='ar';
  let text:string;
  if(details.purpose==='career'&&!details.role&&details.state==='collecting')text=ar
    ? 'أهلًا بيك 🤍 يسعدنا اهتمامك بالشغل مع IRAM.\n\nإيه الوظيفة أو الدور اللي حابب تقدم عليه؟'
    : 'Thanks for your interest in joining IRAM 🤍\n\nWhat job role would you like to apply for?';
  else if(details.purpose==='career'&&details.state==='ready')text=ar
    ? 'شكرًا ليك، سجلت الوظيفة اللي مهتم بيها واسمك ورقمك 🤍\n\nحد من فريق IRAM هيتواصل معاك لو فيه احتياج للدور ده.'
    : 'Thank you, I’ve saved your desired role, name and phone number 🤍\n\nSomeone from IRAM will contact you if this role is needed.';
  else if(details.state==='ready')text=ar
    ? 'شكرًا ليك، سجلت اسمك ورقم التواصل 🤍\n\nالمساعد الذكي اتوقف دلوقتي في المحادثة دي، وحد من فريق IRAM هيتواصل معاك خلال 24 ساعة.\n\nلو حابب تلغي طلب المتابعة وترجع للمساعد الذكي، اكتب AI أو Cancel.'
    : 'Thank you, I’ve saved your name and contact number 🤍\n\nThe AI assistant is now turned off for this chat. Someone from IRAM will contact you within the next 24 hours.\n\nTo cancel this follow-up and return to the AI assistant, type AI or Cancel.';
  else if(details.state==='declined')text=ar
    ? 'ولا يهمك، مشاركة بياناتك اختيارية 🤍\n\nالمساعد الذكي اتوقف في المحادثة دي علشان فريق IRAM يراجع طلبك ويرد عليك هنا. لو حابب تلغي طلب المتابعة وترجع للمساعد الذكي، اكتب AI أو Cancel.'
    : 'No problem, sharing your details is optional 🤍\n\nThe AI assistant is paused for this chat so the IRAM team can review your request and respond here. To cancel the follow-up and return to the AI assistant, type AI or Cancel.';
  else {
    const intro=details.purpose==='career'?(ar?'شكرًا لاهتمامك بالانضمام لفريق IRAM 🤍':'Thank you for your interest in joining IRAM 🤍'):ar?'خلّينا نخلي حد من فريق IRAM يتابع طلبك شخصيًا 🤍':'Let’s have someone from IRAM help you personally 🤍';
    const question=!details.name&&!details.phone
      ? ar?'ممكن اسمك ورقم التليفون اللي تحب نتواصل معاك عليه؟':'Could you share your name and the best phone number to contact you on?'
      : !details.name?ar?'ممكن اسمك علشان نكمل طلب المتابعة؟':'Could you share your name to complete the follow-up request?'
      : ar?'شكرًا ليك. ممكن رقم تليفون صحيح للتواصل، بكود الدولة لو الرقم خارج مصر؟':'Thank you. What’s the best phone number to reach you on? Please include the country code if it’s outside Egypt.';
    text=`${intro}\n\n${question}`;
  }
  return {text,action:details.state==='collecting'?'clarify':'handoff',reason,sources:[],attentionSummary:summary,followUp:{state:details.state,name:details.name,phone:details.phone,...(details.purpose?{purpose:details.purpose,role:details.role??null}:{})}};
}
export function beginFollowUp(context:MessageContext,decision:AgentDecision):AgentDecision {
  const existing=context.followUp?.state==='collecting'?context.followUp:undefined;
  // Only take explicitly labelled names from the original issue, never infer from profile metadata.
  const name=existing?.name??contactName(context.text??'',false);
  const phone=existing?.phone??((name||labelledPhone.test(context.text??''))?contactPhone(context.text??''):null);
  return {...reply(context,decision.reason,decision.attentionSummary??'The customer needs personal help with this request.',
    {state:name&&phone?'ready':'collecting',name,phone}),usage:decision.usage};
}
export function continueFollowUp(context:MessageContext):AgentDecision|null {
  const current=context.followUp;if(current?.state!=='collecting')return null;
  const text=context.text?.trim()??'';
  if(/^(?:no thanks|skip)[.! ]*$|(?:don't|do not|won't|rather not).{0,20}(?:share|give).{0,20}(?:number|name|details)|(?:مش|لا).{0,15}(?:هدي|هقول|اشارك)|بدون رقم|مش حابب.{0,20}(?:رقم|بيانات|اسم)/i.test(text))
    return reply(context,current.reason,current.summary,{...current,state:'declined'});
  if(current.purpose==='career'&&!current.role){
    // A role is user-provided text, not an inferred vacancy. New questions can leave this flow.
    if(!text||text.length>120||/[?؟]/.test(text)||/\b(?:where|when|branches|hours|price)\b|(?:فروع|مواعيد|سعر|فين الفرع)/i.test(text))return null;
    if(isCareerEnquiry(text)||contactPhone(text)||/^(?:hi|hello|thanks|yes|yeah|sure|اه|آه|ايوه|أيوه|اهلا|شكرا|تمام)[.!؟? ]*$/i.test(text))return reply(context,current.reason,current.summary,current);
    const role=text.replace(/[;؛]/g,'،');
    return reply(context,'career_application',`Job enquiry: desired role “${role}”. Contact only if this role is needed.`,{...current,role});
  }
  const lastAssistant=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content??'';
  const wasAskedForContact=/your name|phone number|ممكن اسمك|رقم التليفون|رقم تليفون/.test(lastAssistant);
  const name=contactName(text,wasAskedForContact&&!current.name);
  const plainPhone=/^[+\d٠-٩۰-۹ ()-]+$/.test(text);
  const phone=plainPhone||name||labelledPhone.test(text)?contactPhone(text):null;
  const contactLike=!!name||!!phone||plainPhone||!text;
  // Let a new business question use normal knowledge handling instead of trapping the user in a form.
  if(!contactLike)return null;
  const details={...current,name:name??current.name,phone:phone??current.phone,state:'collecting' as FollowUpDetails['state']};
  if(details.name&&details.phone)details.state='ready';
  return reply(context,current.reason,current.summary,details);
}

export function isCareerEnquiry(text:string):boolean {
  const normalized=normalizeIntent(text);
  if(/(?:مش|لا)\s+(?:عايز|عاوز|محتاج)\s+(?:شغل|اشتغل)|\b(?:not looking for|don't want) (?:a )?(?:job|work)\b/i.test(normalized))return false;
  return /(?:محتاجين|عايزين|عاوزين|بتحتاجوا|بتدوروا على|بتعينوا).{0,20}(?:عماله|عمال|موظفين|موظف|ناس|حد)|(?:فرصه شغل|تقديم شغل|طلبات توظيف|وظيفه شاغره|وظائف شاغره|قسم التوظيف|اداره الموارد البشريه|الموارد البشريه|موارد بشريه|اتش\s*ار)|\b(?:need|looking for|recruit).{0,20}(?:staff|workers|employees)\b|\bjoin (?:your|the) team\b|(?:محتاج|عايز|عاوز|بدور على|ابحث عن)\s+(?:شغل|وظيفه|وظيفة|عمل)|(?:عايز|عاوز|حابب|ممكن)\s+اشتغل|(?:وظائف|وظايف|توظيف|فرص عمل)|\b(?:hr|human resources?|job|jobs|employment|career|careers|vacanc(?:y|ies)|hiring|recruit(?:er|ers|ing|ment)?|cv|resume|résumé)\b|\b(?:want|wanna|like|looking|apply).{0,25}\bwork (?:at|with|for)\b/i.test(normalized);
}
export function beginCareer(context:MessageContext):AgentDecision {
  return reply({...context,followUp:undefined},'career_application','The customer wants to work at IRAM. Collect the desired role first, then name and phone. Contact only if the role is needed.',
    {purpose:'career',role:null,state:'collecting',name:null,phone:null});
}

export function assistantResumedReply(context:MessageContext):AgentDecision {
  const lastAssistant=[...(context.history??[])].reverse().find(message=>message.role==='assistant')?.content??'';
  const ar=replyLanguage(lastAssistant||(context.text??''))==='ar';
  return {action:'clarify',reason:'assistant_resumed',sources:[],text:ar
    ? 'تم إلغاء طلب المتابعة، والمساعد الذكي رجع يشتغل في المحادثة دي 🤍\n\nأقدر أساعدك بإيه؟'
    : 'Your personal follow-up has been cancelled, and the AI assistant is back on for this chat 🤍\n\nHow can I help you?'};
}

/** Recover a yes/no hiring clarification issued before a career flow was persisted. */
export function confirmsCareer(context:MessageContext):boolean {
  if(!/^(?:yes|yeah|yep|sure|correct|اه|ايوه|نعم|تمام)[.!؟? ]*$/i.test(normalizeIntent(context.text??'').trim()))return false;
  const last=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content??'';
  return /(?:هل تقصد|تقصد انك|do you mean|are you (?:asking|looking)|would you like)/i.test(normalizeIntent(last))&&/(?:تشتغل|اشتغل|العمل|عماله|وظيفه|job|work|join|hiring)/i.test(normalizeIntent(last));
}
