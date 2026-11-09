import { after } from 'next/server';
import { pilotConfigurationFailureCode, readPilotVerifyToken } from '@/config/whatsapp-connections';
import { createMessagingRuntime } from '@/modules/messaging/runtime';
import { drainMessages } from '@/modules/messaging/process-incoming-message';
import { receiveWebhook, verifyWebhook } from '@/modules/whatsapp/webhook';
export const runtime='nodejs';
export const maxDuration=60;
export function GET(request:Request) {
  try {
    return verifyWebhook(request,readPilotVerifyToken());
  } catch {return new Response('Not configured',{status:503});}
}
export async function POST(request:Request) {
  try {
    const deps=createMessagingRuntime('pilot');
    const {connection}=deps;
    const response=await receiveWebhook(request,{repository:deps.repository,appSecret:connection.appSecret,
      phoneNumberId:connection.phoneNumberId,recipients:connection.recipients});
    if(response.ok&&connection.sendEnabled)after(async()=>{try{await drainMessages(deps,3);}catch{console.error('pilot_worker_failed');}});
    return response;
  } catch (error) {
    console.error(`pilot_configuration_failed:${pilotConfigurationFailureCode(error)}`);
    return new Response('Not configured',{status:503});
  }
}
