import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/client';
import { readEnvironment } from '@/config/env';
import { connectionForChannel, readPilotConnection, testConnection } from '@/config/whatsapp-connections';
import { handleManualReply, type ManualReplyRepository } from '@/modules/admin/manual-reply';
import { ConfiguredMetaMessageSender } from '@/modules/whatsapp/sender';
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
      const pilot=readPilotConnection();
      const connections=[testConnection(env),...(pilot?[pilot]:[])];
      const repository:ManualReplyRepository={
        prepare:async(actor,input)=>{
          // The browser supplies a conversation, never the tenant or credential to use.
          const conversation=await db.from('conversations').select('tenant_id,channel_id').eq('id',input.conversationId).single();
          if(conversation.error||!conversation.data)throw new Error('Reply preparation failed');
          const channel=await db.from('whatsapp_channels').select('tenant_id,phone_number_id,mode')
            .eq('tenant_id',conversation.data.tenant_id).eq('id',conversation.data.channel_id).single();
          const connection=channel.data&&connectionForChannel(connections,channel.data);
          if(channel.error||!connection?.sendEnabled)throw new Error('Reply channel unavailable');
          const {data,error}=await db.rpc('prepare_manual_reply',{p_actor:actor,p_conversation:input.conversationId,p_request:input.requestId,p_body:input.text,
            p_phone:connection.phoneNumberId,p_allowed:connection.recipients});
          if(error||!data)throw new Error('Reply preparation failed');return data;
        },
        finish:async(id,state,provider,errorCode)=>{
          const {error}=await db.rpc('finish_manual_reply',{p_request:id,p_state:state,p_provider:provider,p_error:errorCode});
          if(error)throw new Error('Reply settlement failed');
        },
      };
      return {repository,sender:new ConfiguredMetaMessageSender(connections)};
    },
  });
}
