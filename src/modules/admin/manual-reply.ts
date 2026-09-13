import { z } from 'zod';
import { SendError } from '../whatsapp/sender';
import type { MessageSender, PreparedReply } from '../messaging/types';

const requestSchema = z.object({ conversationId:z.uuid(), requestId:z.uuid(), text:z.string().trim().min(1).max(4096) }).strict();
type State = 'sending'|'sent'|'failed'|'needs_review';
export interface ManualReplyRepository {
  prepare(actor:string, input:z.infer<typeof requestSchema>):Promise<{state:'new';reply:PreparedReply}|{state:State}>;
  finish(requestId:string,state:Exclude<State,'sending'>,providerId:string|null,error:string|null):Promise<void>;
}
/** Auth is checked before parsing customer text or constructing privileged messaging services. */
export async function handleManualReply(request:Request, deps:{
  authenticate:(token:string)=>Promise<string|null>;
  services:()=>{repository:ManualReplyRepository;sender:MessageSender};
}) {
  const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  const authorization=request.headers.get('authorization')??'';
  if (!authorization.startsWith('Bearer ')) return respond({error:'Please sign in again.'},401);
  let actor:string|null;
  try { actor=await deps.authenticate(authorization.slice(7)); } catch { return respond({error:'Could not verify your session.'},401); }
  if (!actor) return respond({error:'Please sign in again.'},401);
  let input:z.infer<typeof requestSchema>;
  try {
    const reader=request.body?.getReader(); if(!reader)throw new Error();
    const decoder=new TextDecoder(); let body='';let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20000){await reader.cancel();return respond({error:'Reply is too long.'},413);}body+=decoder.decode(value,{stream:true});}
    input=requestSchema.parse(JSON.parse(body+decoder.decode()));
  } catch { return respond({error:'Enter a valid reply of up to 4,096 characters.'},400); }
  let services:ReturnType<typeof deps.services>;
  let prepared:Awaited<ReturnType<ManualReplyRepository['prepare']>>;
  try { services=deps.services();prepared=await services.repository.prepare(actor,input); }
  catch { return respond({error:'Could not prepare this reply. Refresh and check your access, pause the assistant, and make sure the customer messaged within the last 24 hours.'},409); }
  if(prepared.state!=='new')return respond({state:prepared.state});
  try {
    const provider=await services.sender.send(prepared.reply);
    await services.repository.finish(input.requestId,'sent',provider,null);
    return respond({state:'sent'});
  } catch(error) {
    const state=error instanceof SendError && !error.ambiguous?'failed':'needs_review';
    try {await services.repository.finish(input.requestId,state,null,error instanceof SendError?error.code:'manual_send_or_commit_unknown');}catch{/* Durable intent must never be sent again. Recovery marks it for review. */}
    return respond({state});
  }
}
