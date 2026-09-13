import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/client';
import { readEnvironment } from '@/config/env';
import { handleManualReply, type ManualReplyRepository } from '@/modules/admin/manual-reply';
import { MetaMessageSender } from '@/modules/whatsapp/sender';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function POST(request:Request){
  return handleManualReply(request,{
    authenticate:async token=>{
      const db=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
      const {data,error}=await db.auth.getUser(token);return error?null:data.user?.id??null;
    },
    services:()=>{
      const env=readEnvironment();const db=createAdminClient();
      const repository:ManualReplyRepository={
        prepare:async(actor,input)=>{
          const {data,error}=await db.rpc('prepare_manual_reply',{p_actor:actor,p_conversation:input.conversationId,p_request:input.requestId,p_body:input.text,
            p_phone:env.WHATSAPP_TEST_PHONE_NUMBER_ID,p_allowed:env.WHATSAPP_TEST_RECIPIENTS});
          if(error||!data)throw new Error('Reply preparation failed');return data;
        },
        finish:async(id,state,provider,errorCode)=>{
          const {error}=await db.rpc('finish_manual_reply',{p_request:id,p_state:state,p_provider:provider,p_error:errorCode});
          if(error)throw new Error('Reply settlement failed');
        },
      };
      return {repository,sender:new MetaMessageSender(env)};
    },
  });
}
