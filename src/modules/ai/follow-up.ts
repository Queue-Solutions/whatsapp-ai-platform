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
  if(/\b(?:hi|hello|thanks|no|yes|yeah|yep|of\s*course|ofcourse|certainly|absolutely|okay|ok|alright|branches|branch|price|where|when|what|how|please|help|online|website|links?|send|sure|jewelry|bullion|btc|don't|not)\b|(?:فروع|سعر|فين|امتي|متى|ازاي|شكرا|اهلا|عايز|عاوز|مش|رقم|تمام|طبعاً|طبعا|أكيد|اكيد|اون ?لاين|ابعت|ياريت|يا ريت|ماشي|ايوه|روابط|موقع|سبائك|سبايك|مجوهرات|الاسكندريه|الاسكندرية|الغردقه|الغردقة)/iu.test(candidate))return null;
  return candidate;
}
function isAcknowledgement(text:string){
  return /^(?:yes|yeah|yep|of\s*course|ofcourse|sure|certainly|absolutely|okay|ok|alright|fine|تمام|طبعاً|طبعا|أكيد|اكيد|ايوه|أيوه|اه|آه|ماشي)[.!،,؟? ]*$/iu.test(text.trim());
}
function reply(context:MessageContext,reason:string,summary:string,details:FollowUpDetails):AgentDecision {
  const lastAssistant=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content;
  const ar=replyLanguage(context.followUp?.state==='collecting'&&lastAssistant?lastAssistant:context.text??'')==='ar';
  let text:string;
  if(details.purpose==='career'&&!details.role&&details.state==='collecting')text=ar
    ? 'يسعدنا اهتمامك بالانضمام إلى فريق IRAM.\n\nما الوظيفة أو الدور الذي ترغب في التقدم إليه؟'
    : 'Thank you for your interest in joining IRAM.\n\nWhich role would you like to apply for?';
  else if(details.purpose==='career'&&details.state==='ready')text=ar
    ? 'شكرًا لك. تم تسجيل الوظيفة التي تهتم بها، إلى جانب اسمك ورقم التواصل.\n\nسيتواصل معك فريق IRAM إذا توفرت فرصة مناسبة لهذا الدور.'
    : 'Thank you. Your preferred role, name and contact number have been saved.\n\nThe IRAM team will contact you if a suitable opportunity becomes available.';
  else if(details.state==='ready')text=ar
    ? 'شكرًا لك. تم تسجيل اسمك ورقم التواصل 🤍\n\nتم إيقاف المساعد الذكي لهذه المحادثة، وسيتواصل معك أحد ممثلي IRAM خلال 24 ساعة.\n\nلإلغاء طلب المتابعة والعودة إلى المساعد الذكي، اكتب Cancel.'
    : 'Thank you. Your name and phone number have been saved 🤍\n\nThe AI assistant is now turned off for this chat. An IRAM representative will contact you within the next 24 hours.\n\nTo cancel this follow-up and return to the AI assistant, type Cancel.';
  else if(details.state==='declined')text=ar
    ? 'مشاركة بيانات التواصل اختيارية.\n\nتم إيقاف المساعد الذكي لهذه المحادثة حتى يتمكن فريق IRAM من مراجعة طلبك والرد هنا. لإلغاء المتابعة والعودة إلى المساعد الذكي، اكتب Cancel.'
    : 'Sharing your contact details is optional.\n\nThe AI assistant is paused for this chat while the IRAM team reviews your request and responds here. To cancel the follow-up and return to the AI assistant, type Cancel.';
  else {
    const intro=details.purpose==='career'?(ar?'يسعدنا اهتمامك بالانضمام إلى فريق IRAM.':'Thank you for your interest in joining IRAM.'):ar?'سيتابع أحد ممثلي IRAM طلبك بصورة شخصية.':'An IRAM representative will assist you personally.';
    const question=!details.name&&!details.phone
      ? ar?'يرجى إرسال اسمك ورقم الهاتف الأنسب للتواصل.':'Please share your name and preferred phone number.'
      : !details.name?ar?'يرجى إرسال اسمك لاستكمال طلب المتابعة.':'Please share your name to complete the follow-up request.'
      : ar?'شكرًا لك. يرجى إرسال رقم هاتف صحيح للتواصل، مع إضافة كود الدولة إذا كان الرقم خارج مصر.':'Thank you. Please share a valid phone number, including the country code if it is outside Egypt.';
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
  // Agreement is not contact data. Keep the form conversational and ask only
  // for the fields that are still missing instead of storing words like
  // “ofcourse” or “sure” as the customer's name.
  if(wasAskedForContact&&isAcknowledgement(text))return reply(context,current.reason,current.summary,current);
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

/** Repeat the active collection question without mutating any saved details. */
export function repeatFollowUp(context:MessageContext):AgentDecision|null {
  const current=context.followUp;
  return current?.state==='collecting'?reply(context,current.reason,current.summary,current):null;
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
    ? 'تم إلغاء طلب المتابعة وإعادة تشغيل المساعد الذكي لهذه المحادثة.\n\nكيف يمكنني مساعدتك؟'
    : 'Your personal follow-up has been cancelled, and the AI assistant is active again for this chat.\n\nHow may I assist you?'};
}

/** Recover a yes/no hiring clarification issued before a career flow was persisted. */
export function confirmsCareer(context:MessageContext):boolean {
  if(!/^(?:yes|yeah|yep|sure|correct|اه|ايوه|نعم|تمام)[.!؟? ]*$/i.test(normalizeIntent(context.text??'').trim()))return false;
  const last=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content??'';
  return /(?:هل تقصد|تقصد انك|do you mean|are you (?:asking|looking)|would you like)/i.test(normalizeIntent(last))&&/(?:تشتغل|اشتغل|العمل|عماله|وظيفه|job|work|join|hiring)/i.test(normalizeIntent(last));
}
