import { createAdminClient } from '../src/lib/supabase/client';
async function main(){
  const db=createAdminClient();
  const phone=process.env.WHATSAPP_TEST_PHONE_NUMBER_ID;
  if(process.env.WHATSAPP_MODE!=='test' || !phone || !/^\d+$/.test(phone))throw new Error('Set the Meta temporary test phone number ID first.');
  const tenantId='11111111-1111-4111-8111-111111111111';
  const {error:t}=await db.from('tenants').upsert({id:tenantId,name:'Queue Solutions Development',slug:'queue-development'},{onConflict:'id'});
  if(t)throw new Error('Tenant setup failed. Apply the migration first.');
  // Never transfer an existing channel between tenants.
  const {data:existing,error:lookup}=await db.from('whatsapp_channels').select('tenant_id,mode').eq('phone_number_id',phone).maybeSingle();
  if(lookup)throw new Error('Channel lookup failed.');
  if(existing){if(existing.tenant_id!==tenantId || existing.mode!=='test')throw new Error('Channel already belongs to another setup.');}
  else {const {error:c}=await db.from('whatsapp_channels').insert({tenant_id:tenantId,phone_number_id:phone,mode:'test'});if(c)throw new Error('Channel setup failed.');}
  console.log('Development tenant and test channel are ready.');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Setup failed');process.exitCode=1;});
