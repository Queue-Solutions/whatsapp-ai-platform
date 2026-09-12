import { createMessagingRuntime } from '@/modules/messaging/runtime';
import { drainMessages } from '@/modules/messaging/process-incoming-message';
import { equalSecret } from '@/modules/whatsapp/security';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function POST(request:Request) {
  const secret=process.env.CRON_SECRET;
  if(!secret || secret.length<32)return new Response('Not configured',{status:503});
  if(!equalSecret(request.headers.get('authorization')??'',`Bearer ${secret}`))return new Response('Unauthorized',{status:401});
  try{return Response.json({results:await drainMessages(createMessagingRuntime(),1)});}
  catch{console.error('message_worker_failed');return new Response('Worker unavailable',{status:503});}
}
// Vercel Cron sends GET. Same authentication and behavior as POST.
export const GET=POST;
