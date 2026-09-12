import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
const databaseEnvironment = z.object({SUPABASE_URL:z.url(),SUPABASE_SECRET_KEY:z.string().min(20)});
/** Server/CLI factory only. Never use this client inside a browser component. */
export function createAdminClient(source: Record<string, string | undefined> = process.env) {
  const result = databaseEnvironment.safeParse(source);
  if (!result.success) throw new Error('Supabase configuration is missing or invalid');
  return createClient(result.data.SUPABASE_URL,result.data.SUPABASE_SECRET_KEY, {
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})},
  });
}
