import type {AgentDecision} from './contracts';
import type {MessageContext} from '../messaging/types';
import {normalizeIntent} from './branch-scope';
import {replyLanguage} from './language';

function directPriceQuestion(text:string){
  const value=normalizeIntent(text);
  if(/\b(?:wrong|incorrect|overcharged|charged twice|complaint)\b|(?:السعر غلط|حاسبتوني|اتحاسبت|خصمتوا|شكوي|شكوى)/.test(value))return false;
  return /\b(?:price|prices|pricing|cost|costs|how much)\b|(?:بكام|بكم|كام سعر|سعر|اسعار|الاسعار|تكلفه)/.test(value);
}

function asksWhy(text:string){
  return /^(?:why|why is that|how come|ليه|ليه كده|ليه كدا|لماذا)[.!،,؟? ]*$/i.test(normalizeIntent(text).trim());
}

function recentPriceQuestion(context:MessageContext){
  const latest=[...(context.history??[])].reverse().find(message=>message.role==='user');
  return !!latest&&directPriceQuestion(latest.content);
}

/** Prices are intentionally live/offline information, so they never enter a knowledge-gap contact form. */
export function pricingReply(context:MessageContext):AgentDecision|null {
  const text=context.text??'';
  const explaining=asksWhy(text)&&recentPriceQuestion(context);
  if(!directPriceQuestion(text)&&!explaining)return null;
  const ar=replyLanguage(explaining?(context.history??[]).findLast(message=>message.role==='user'&&directPriceQuestion(message.content))?.content??text:text)==='ar';
  return {action:'answer',reason:'live_price_information',sources:[],text:explaining
    ?ar
      ?'لأن الأسعار بتتغير باستمرار، فالمساعد الذكي ما يقدرش يعرض سعر حالي بشكل دقيق. تقدر تزور أي فرع من فروع IRAM لمعرفة السعر المحدث وقت الزيارة.'
      :'Because prices change constantly, the AI assistant cannot provide a reliably current price. Please visit any IRAM branch to receive the latest price at the time of your visit.'
    :ar
      ?'الأسعار بتتغير باستمرار، لذلك الأسعار الحالية مش متاحة من خلال المساعد الذكي. تقدر تزور أي فرع من فروع IRAM لمعرفة السعر المحدث وقت الزيارة.'
      :'Prices change constantly, so current prices are not available through the AI assistant. Please visit any IRAM branch to receive the latest price at the time of your visit.'};
}
