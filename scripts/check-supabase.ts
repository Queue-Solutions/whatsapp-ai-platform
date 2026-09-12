import { createAdminClient } from '../src/lib/supabase/client';
async function main(){
  const db=createAdminClient();
  const {error}=await db.from('tenants').select('id').limit(1);
  if(error){console.log(`Database check failed (${error.code??'network'}). Confirm credentials and apply the migration.`);process.exitCode=1;return;}
  console.log('Supabase connection and foundation schema verified.');
}
main().catch(()=>{console.error('Supabase configuration or connection failed.');process.exitCode=1;});
