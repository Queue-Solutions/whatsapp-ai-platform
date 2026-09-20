import type {MessageContext} from '../messaging/types';
import {normalizeIntent} from './branch-scope';
import {replyLanguage} from './language';

export function isShortAcceptance(text:string){
  return /^(?:yes|yeah|yep|sure|please|send(?: it| them)?|go ahead|where|اه|ايوه|نعم|تمام|طبعا|ياريت|يا ريت|ماشي|ابعت|ابعث|فين)[.!؟? ]*$/.test(normalizeIntent(text).trim());
}
/** Resolve the last offer before retrieval; keep original history as untrusted context. */
export function resolveContinuation(context:MessageContext):MessageContext {
  if(!isShortAcceptance(context.text??''))return context;
  const previous=[...(context.history??[])].reverse().find(m=>m.role==='assistant')?.content??'';
  const t=normalizeIntent(previous),ar=replyLanguage(context.text??'')==='ar';
  if(/(?:روابط|اللينك|لينكات|\blinks?\b)/.test(t)&&/(?:اونلاين|اون لاين|انترنت|موقع|online|website|social)/.test(t))
    return {...context,text:ar?'ابعت روابط الشراء أونلاين والموقع الرسمي.':'Send the online shopping and official website links.'};
  if(/(?:فرع|فروع|\bbranch(?:es)?\b)/.test(t)&&/(?:تحب|تحتاج|مساعده|اقرب|هل|would you|do you|can i|want|need|like)/.test(t))
    return {...context,text:ar?'عايز أعرف الفروع.':'I would like to know the branches.'};
  return context;
}

type HistoryRow={body:string|null;direction:string};
/** Preserve a contiguous recent window. Never skip a large assistant turn and keep stale older turns. */
export function boundedHistory(rows:HistoryRow[],maxBytes=9000):NonNullable<MessageContext['history']>{
  const result:NonNullable<MessageContext['history']>=[];let bytes=0;
  for(const row of rows){
    if(!row.body?.trim())continue;
    const size=Buffer.byteLength(row.body,'utf8');
    if(bytes+size>maxBytes)break;
    result.push({role:row.direction==='inbound'?'user':'assistant',content:row.body});bytes+=size;
  }
  return result.reverse();
}
