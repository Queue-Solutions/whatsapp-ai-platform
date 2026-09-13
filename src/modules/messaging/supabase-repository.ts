import type { AgentDecision } from '../ai/contracts';
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
    await this.rpc('expire_manual_replies', {});
    const rows=await this.rpc<MessageJob[]>('claim_message_job',{p_phone:this.phoneNumberId});
    return rows[0]??null;
  }
  async context(job: MessageJob): Promise<MessageContext> {
    const {data,error}=await this.db.from('messages').select('tenant_id,conversation_id,channel_id,body,message_type,created_at')
      .eq('id',job.inbound_message_id).eq('tenant_id',job.tenant_id).single();
    if(error || !data) throw new Error('Message context unavailable');
    const [conversation, channel, history] = await Promise.all([
      this.db.from('conversations').select('automation_mode,automation_epoch,status,last_inbound_at').eq('tenant_id', job.tenant_id).eq('id',data.conversation_id).single(),
      this.db.from('whatsapp_channels').select('enabled,mode,phone_number_id').eq('tenant_id',job.tenant_id).eq('id',data.channel_id).single(),
      this.db.from('messages').select('body,direction').eq('tenant_id',job.tenant_id).eq('conversation_id',data.conversation_id)
        .lt('created_at',data.created_at).in('delivery_status',['received','sent','delivered','read']).order('created_at',{ascending:false}).limit(6),
    ]);
    if (conversation.error || channel.error || history.error) throw new Error('Message context unavailable');
    const c = conversation.data; const ch = channel.data;
    const eligible = c.automation_mode === 'auto' && c.status === 'open' && ch.enabled && ch.mode === 'test'
      && job.automation_epoch === c.automation_epoch
      && ch.phone_number_id === this.phoneNumberId && Date.parse(c.last_inbound_at) >= Date.now() - (23*60+55)*60000;
    let bytes = 0;
    const boundedHistory = history.data.filter(m => typeof m.body === 'string' && m.body.trim()).flatMap(m => {
      const content = m.body as string; const size = Buffer.byteLength(content,'utf8');
      if (bytes + size > 2500) return []; bytes += size;
      return [{ role: m.direction === 'inbound' ? 'user' as const : 'assistant' as const, content }];
    }).reverse();
    return {tenantId:data.tenant_id,conversationId:data.conversation_id,text:data.body,type:data.message_type,eligible,history:boundedHistory};
  }
  prepare(job: MessageJob, text: string) {
    return this.rpc<PreparedReply|null>('prepare_message_reply',{p_job:job.id,p_lease:job.lease_token,p_body:text});
  }
  prepareDecision(job: MessageJob, decision: AgentDecision) {
    return this.rpc<PreparedReply|null>('prepare_ai_reply', { p_job: job.id, p_lease: job.lease_token,
      p_body: decision.text, p_action: decision.action, p_sources: decision.sources });
  }
  async complete(job: MessageJob, providerMessageId: string) {
    await this.rpc('complete_message_job',{p_job:job.id,p_lease:job.lease_token,p_provider_id:providerMessageId});
  }
  async fail(job: MessageJob, state: 'failed'|'needs_review', code: string) {
    await this.rpc('fail_message_job',{p_job:job.id,p_lease:job.lease_token,p_state:state,p_code:code});
  }
}
