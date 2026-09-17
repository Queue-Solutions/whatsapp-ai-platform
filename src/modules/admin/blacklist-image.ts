import type {SupabaseClient} from '@supabase/supabase-js';
import type {Environment} from '../../config/env';
import {OpenAiModerator} from '../moderation/provider';
import {z} from 'zod';
export async function handleBlacklistImage(request:Request,deps:{
  authenticate:(token:string)=>Promise<boolean>;
  load:(token:string,message:string)=>Promise<{bytes:Uint8Array;mime:string}|null>;
}){
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"};
  const fail=(status:number)=>Response.json({error:'Image unavailable.'},{status,headers});
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer '))return fail(401);
  const token=authorization.slice(7);
  try{if(!await deps.authenticate(token))return fail(401);}catch{return fail(401);}
  const id=z.uuid().safeParse(new URL(request.url).searchParams.get('message'));if(!id.success)return fail(400);
  try{const image=await deps.load(token,id.data);if(!image)return fail(404);
    return new Response(new Uint8Array(image.bytes),{headers:{...headers,'Content-Type':image.mime}});
  }catch{return fail(404);}
}

/** Caller supplies the authenticated user client, never a service-role client. */
export async function loadBlacklistImage(db:SupabaseClient,env:Environment,id:string){
  const {data:block,error}=await db.from('customer_blacklist').select('tenant_id').eq('message_id',id).maybeSingle();
  if(error||!block)return null;
  const {data:m,error:messageError}=await db.from('messages').select('media_id,channel_id,message_type').eq('tenant_id',block.tenant_id).eq('id',id).single();
  if(messageError||m.message_type!=='image'||!m.media_id)return null;
  const {data:ch,error:channelError}=await db.from('whatsapp_channels').select('phone_number_id,mode').eq('tenant_id',block.tenant_id).eq('id',m.channel_id).single();
  if(channelError||ch.mode!=='test'||ch.phone_number_id!==env.WHATSAPP_TEST_PHONE_NUMBER_ID)return null;
  return new OpenAiModerator(undefined,env).image(m.media_id);
}
