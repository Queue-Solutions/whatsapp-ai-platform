import {createClient} from '@supabase/supabase-js';
import {readEnvironment} from '@/config/env';
import {handleBlacklistImage,loadBlacklistImage} from '@/modules/admin/blacklist-image';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const client=(token:string)=>createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  return handleBlacklistImage(request,{
    authenticate:async token=>{const {data,error}=await client(token).auth.getUser(token);return !error&&!!data.user;},
    load:async(token,id)=>loadBlacklistImage(client(token),readEnvironment(),id),
  });
}
