import { after } from 'next/server';
import { createMessagingRuntime } from '@/modules/messaging/runtime';
import { drainMessages } from '@/modules/messaging/process-incoming-message';
import { receiveWebhook, verifyWebhook } from '@/modules/whatsapp/webhook';
export const runtime='nodejs';
export const maxDuration=60;
export function GET(request:Request) {
  const token=process.env.WHATSAPP_VERIFY_TOKEN;
  if(!token || token.length<16)return new Response('Not configured',{status:503});
  return verifyWebhook(request,token);
}
export async function POST(request:Request) {
  try {
    const deps=createMessagingRuntime();
    const response=await receiveWebhook(request,{repository:deps.repository,appSecret:deps.env.META_APP_SECRET,
      phoneNumberId:deps.env.WHATSAPP_TEST_PHONE_NUMBER_ID,recipients:deps.env.WHATSAPP_TEST_RECIPIENTS});
    if(response.ok) after(async()=>{try{await drainMessages(deps,1);}catch{console.error('message_worker_failed');}});
    return response;
  } catch {console.error('webhook_configuration_failed');return new Response('Not configured',{status:503});}
}
