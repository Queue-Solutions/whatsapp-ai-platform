import type { MessagingRepository } from '../messaging/types';
import { parseWebhook } from './parser';
import { equalSecret, validSignature } from './security';
export function verifyWebhook(request: Request, verifyToken: string): Response {
  const q=new URL(request.url).searchParams;
  if(q.get('hub.mode')!=='subscribe' || !q.get('hub.challenge') ||
    !equalSecret(q.get('hub.verify_token')??'',verifyToken)) return new Response('Forbidden',{status:403});
  return new Response(q.get('hub.challenge'),{headers:{'Content-Type':'text/plain'}});
}
async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const maximum=1024*1024;
  if(Number(request.headers.get('content-length'))>maximum) throw new RangeError();
  const reader=request.body?.getReader();
  if(!reader) return new Uint8Array();
  let total=0; const chunks:Uint8Array[]=[];
  try {
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;
      if(total>maximum){await reader.cancel();throw new RangeError();} chunks.push(value);}
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks);
}
export async function receiveWebhook(request: Request, options: {
  appSecret:string;phoneNumberId:string;recipients:string[];repository:MessagingRepository;
}):Promise<Response> {
  let raw:Uint8Array;
  try{raw=await readBoundedBody(request);}catch(error){return new Response('Invalid body',{status:error instanceof RangeError?413:400});}
  if(!validSignature(raw,request.headers.get('x-hub-signature-256'),options.appSecret)) return new Response('Forbidden',{status:403});
  let parsed:ReturnType<typeof parseWebhook>;
  try{parsed=parseWebhook(JSON.parse(Buffer.from(raw).toString('utf8')));}catch{return new Response('Invalid payload',{status:400});}
  try {
    for(const m of parsed.messages) {
      if(m.phoneNumberId!==options.phoneNumberId || !options.recipients.includes(m.from)) continue;
      await options.repository.ingest(m);
    }
    for(const s of parsed.statuses) if(s.phoneNumberId===options.phoneNumberId) await options.repository.recordStatus(s);
  } catch {
    // A partial batch is safe to replay; each event is deduplicated in PostgreSQL.
    console.error('webhook_persistence_failed');
    return new Response('Retry later',{status:503});
  }
  return Response.json({received:true});
}
