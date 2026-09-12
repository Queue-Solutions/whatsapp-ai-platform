import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeliveryStatus, IncomingMessage, MessageContext, MessageJob, MessagingRepository, PreparedReply } from './types';

export class SupabaseMessagingRepository implements MessagingRepository {
  constructor(private db: SupabaseClient, private phoneNumberId: string) {}
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const {data,error}=await this.db.rpc(name,args);
    if(error) throw new Error(`Database operation failed: ${name}`);
    return data as T;
  }
  async ingest(m: IncomingMessage) {
    if(m.phoneNumberId!==this.phoneNumberId) throw new Error('Channel mismatch');
    await this.rpc('ingest_whatsapp_message',{p_phone:m.phoneNumberId,p_provider_id:m.providerMessageId,
      p_from:m.from,p_name:m.displayName??null,p_occurred:m.occurredAt,p_type:m.type,p_body:m.text});
  }
  async recordStatus(s: DeliveryStatus) {
    if(s.phoneNumberId!==this.phoneNumberId) throw new Error('Channel mismatch');
    await this.rpc('record_whatsapp_status',{p_phone:s.phoneNumberId,p_provider_id:s.providerMessageId,
      p_status:s.status,p_occurred:s.occurredAt,p_code:s.errorCode??null});
  }
  async claim() {
    const rows=await this.rpc<MessageJob[]>('claim_message_job',{p_phone:this.phoneNumberId});
    return rows[0]??null;
  }
  async context(job: MessageJob): Promise<MessageContext> {
    const {data,error}=await this.db.from('messages').select('tenant_id,conversation_id,body,message_type')
      .eq('id',job.inbound_message_id).eq('tenant_id',job.tenant_id).single();
    if(error || !data) throw new Error('Message context unavailable');
    return {tenantId:data.tenant_id,conversationId:data.conversation_id,text:data.body,type:data.message_type};
  }
  prepare(job: MessageJob, text: string) {
    return this.rpc<PreparedReply|null>('prepare_message_reply',{p_job:job.id,p_lease:job.lease_token,p_body:text});
  }
  async complete(job: MessageJob, providerMessageId: string) {
    await this.rpc('complete_message_job',{p_job:job.id,p_lease:job.lease_token,p_provider_id:providerMessageId});
  }
  async fail(job: MessageJob, state: 'failed'|'needs_review', code: string) {
    await this.rpc('fail_message_job',{p_job:job.id,p_lease:job.lease_token,p_state:state,p_code:code});
  }
}
