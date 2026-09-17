import type {AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
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
  if(/\b(?:hi|hello|thanks|no|yes|branches|branch|price|where|when|what|how|please|help|don't|not)\b|(?:فروع|سعر|فين|امتي|متى|ازاي|شكرا|اهلا|عايز|عاوز|مش|رقم|تمام)/iu.test(candidate))return null;
  return candidate;
}
function reply(context:MessageContext,reason:string,summary:string,details:FollowUpDetails):AgentDecision {
  const lastAssistant=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content;
  const ar=replyLanguage(context.followUp?.state==='collecting'&&lastAssistant?lastAssistant:context.text??'')==='ar';
  let text:string;
  if(details.purpose==='career'&&!details.role&&details.state==='collecting')text=ar
    ? 'أهلًا بيك 🤍 يسعدنا اهتمامك بالشغل مع ارم.\n\nإيه الوظيفة أو الدور اللي حابب تقدم عليه؟'
    : 'Thanks for your interest in joining IRAM 🤍\n\nWhat job role would you like to apply for?';
  else if(details.purpose==='career'&&details.state==='ready')text=ar
    ? 'شكرًا ليك، سجلت الوظيفة اللي مهتم بيها واسمك ورقمك 🤍\n\nحد من فريق ارم هيتواصل معاك لو فيه احتياج للدور ده.'
    : 'Thank you, I’ve saved your desired role, name and phone number 🤍\n\nSomeone from IRAM will contact you if this role is needed.';
  else if(details.state==='ready')text=ar
    ? 'شكرًا ليك، سجلت اسمك ورقم التواصل 🤍\n\nحد من فريق ارم هيتواصل معاك شخصيًا قريبًا.'
    : 'Thank you, I’ve saved your name and contact number 🤍\n\nSomeone from IRAM will contact you personally shortly.';
  else if(details.state==='declined')text=ar
    ? 'ولا يهمك، مشاركة بياناتك اختيارية 🤍\n\nهسيب المحادثة لصاحب النشاط علشان يراجع طلبك ويرد عليك هنا.'
    : 'No problem, sharing your details is optional 🤍\n\nI’ll leave this conversation for the business owner to review and respond here.';
  else {
    const intro=details.purpose==='career'?(ar?'شكرًا لاهتمامك بالانضمام لفريق ارم 🤍':'Thank you for your interest in joining IRAM 🤍'):ar?'خلّينا نخلي حد من فريق ارم يتابع طلبك شخصيًا 🤍':'Let’s have someone from IRAM help you personally 🤍';
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
    if(contactPhone(text)||/^(?:hi|hello|thanks|اهلا|شكرا|تمام)$/i.test(text))return reply(context,current.reason,current.summary,current);
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
  const normalized=text.normalize('NFKC').replace(/[\u064b-\u065f\u0670]/g,'').replace(/[إأآ]/g,'ا');
  if(/(?:مش|لا)\s+(?:عايز|عاوز|محتاج)\s+(?:شغل|اشتغل)|\b(?:not looking for|don't want) (?:a )?(?:job|work)\b/i.test(normalized))return false;
  return /(?:محتاج|عايز|عاوز|بدور على|ابحث عن)\s+(?:شغل|وظيفه|وظيفة|عمل)|(?:عايز|عاوز|حابب|ممكن)\s+اشتغل|(?:وظائف|وظايف|توظيف|فرص عمل)|\b(?:job|jobs|career|careers|vacanc(?:y|ies)|hiring|recruiting)\b|\b(?:want|like|looking|apply).{0,25}\bwork (?:at|with|for)\b/i.test(normalized);
}
export function beginCareer(context:MessageContext):AgentDecision {
  return reply(context,'career_application','The customer wants to work at IRAM. Collect the desired role first, then name and phone. Contact only if the role is needed.',
    {purpose:'career',role:null,state:'collecting',name:null,phone:null});
}
