import { createHmac, randomUUID } from 'node:crypto';
import { readEnvironment } from '../src/config/env';
async function main(){
  const env=readEnvironment();
  const base=process.env.SMOKE_BASE_URL??'http://localhost:3000';
  if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Simulator only targets localhost.');
  const id=`wamid.local.${randomUUID()}`;
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{
    metadata:{phone_number_id:env.WHATSAPP_TEST_PHONE_NUMBER_ID},
    messages:[{from:env.WHATSAPP_TEST_RECIPIENTS[0],id,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Hello / أهلاً'}}],
  }}]}]});
  console.log('This signed simulation may send one real echo to your allowlisted test recipient.');
  const headers={'content-type':'application/json','x-hub-signature-256':`sha256=${createHmac('sha256',env.META_APP_SECRET).update(body).digest('hex')}`};
  for(let i=0;i<2;i++){
    const response=await fetch(`${base}/api/webhooks/whatsapp`,{method:'POST',headers,body});
    console.log(`Webhook attempt ${i+1}: HTTP ${response.status}`);if(!response.ok)process.exitCode=1;
  }
  console.log(`Inspect messages/jobs for ${id}. Expected: one inbound and at most one outbound attempt.`);
}
main().catch(()=>{console.error('Simulation failed. Check local configuration and server.');process.exitCode=1;});
