import {technicalFailure,AI_RECOVERY_SUMMARY} from '../ai/recovery';
import {boundedHistory} from '../ai/conversation-context';
import type { AgentDecision } from '../ai/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeliveryStatus, IdentityChange, IncomingMessage, MessageContext, MessageJob, MessagingRepository, PreparedReply } from './types';

export class SupabaseMessagingRepository implements MessagingRepository {
  constructor(private db: SupabaseClient, private phoneNumberId: string) {}
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const {data,error}=await this.db.rpc(name,args);
    if(error) throw new Error(`Database operation failed: ${name}`);
    return data as T;
  }
  async ingest(m: IncomingMessage) {
    if(m.phoneNumberId!==this.phoneNumberId) throw new Error('Channel mismatch');
    await this.rpc('ingest_moderated_message',{p_phone:m.phoneNumberId,p_provider_id:m.providerMessageId,
      p_from:m.from,p_user_id:m.userId??null,p_username:m.username??null,p_name:m.displayName??null,p_occurred:m.occurredAt,p_type:m.type,p_body:m.text,p_media_id:m.mediaId??null});
  }
  isAllowedIdentity(identifier:string,allowed:string[]){
    return this.rpc<boolean>('is_allowed_whatsapp_identity',{p_phone:this.phoneNumberId,p_identifier:identifier,p_allowed:allowed});
  }
  async updateIdentity(change:IdentityChange){
    if(change.phoneNumberId!==this.phoneNumberId)throw new Error('Channel mismatch');
    await this.rpc('update_whatsapp_identity',{p_phone:change.phoneNumberId,p_provider_id:change.providerMessageId,p_previous:change.previousIdentifier,
      p_new_phone:change.newPhone??null,p_new_user_id:change.newUserId,p_occurred:change.occurredAt});
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
    const {data,error}=await this.db.from('messages').select('tenant_id,conversation_id,channel_id,body,message_type,media_id,moderation_state,created_at')
      .eq('id',job.inbound_message_id).eq('tenant_id',job.tenant_id).single();
    if(error || !data) throw new Error('Message context unavailable');
    const [conversation, channel, history] = await Promise.all([
      this.db.from('conversations').select('customer_id,followup_purpose,followup_role,automation_mode,automation_epoch,status,last_inbound_at,followup_state,followup_name,followup_phone,attention_reason,attention_summary').eq('tenant_id', job.tenant_id).eq('id',data.conversation_id).single(),
      this.db.from('whatsapp_channels').select('enabled,mode,phone_number_id,assistant_scope').eq('tenant_id',job.tenant_id).eq('id',data.channel_id).single(),
      this.db.from('messages').select('body,direction').eq('tenant_id',job.tenant_id).eq('conversation_id',data.conversation_id)
        .lt('created_at',data.created_at).in('delivery_status',['received','sent','delivered','read']).order('created_at',{ascending:false}).limit(16),
    ]);
    if (conversation.error || channel.error || history.error) throw new Error('Message context unavailable');
    const c = conversation.data; const ch = channel.data;
    const selected=ch.assistant_scope==='selected'?await this.db.from('assistant_selected_conversations').select('conversation_id')
      .eq('tenant_id',job.tenant_id).eq('channel_id',data.channel_id).eq('conversation_id',data.conversation_id).maybeSingle():null;
    if(selected?.error)throw new Error('Assistant availability unavailable');
    const assistantAvailable=ch.assistant_scope==='all'||(ch.assistant_scope==='selected'&&!!selected?.data);
    const block=await this.db.from('customer_blacklist').select('state').eq('tenant_id',job.tenant_id).eq('customer_id',c.customer_id).maybeSingle();
    if(block.error)throw new Error('Block status unavailable');
    const blocked=!!block.data&&block.data.state!=='removed';
    const eligible = assistantAvailable && !blocked && c.automation_mode === 'auto' && c.status === 'open' && ch.enabled && ch.mode === 'test'
      && job.automation_epoch === c.automation_epoch
      && ch.phone_number_id === this.phoneNumberId && Date.parse(c.last_inbound_at) >= Date.now() - (23*60+55)*60000;
    return {tenantId:data.tenant_id,conversationId:data.conversation_id,text:data.body,type:data.message_type,mediaId:data.media_id??undefined,moderationState:data.moderation_state,blocked,eligible,resumeRequested:job.customer_resume===true,history:boundedHistory(history.data),
      followUp:c.followup_state==='collecting'?{state:'collecting',purpose:c.followup_purpose==='career'?'career':undefined,role:c.followup_role,name:c.followup_name,phone:c.followup_phone,
        reason:c.attention_reason==='knowledge_gap'?'missing_business_information':c.attention_reason,summary:c.attention_summary}:undefined};
  }
  moderate(job:MessageJob,result:import('../moderation/provider').ModerationResult){
    return this.rpc<boolean>('finish_content_check',{p_job:job.id,p_lease:job.lease_token,p_state:result.state,p_categories:result.categories});
  }
  prepare(job: MessageJob, text: string) {
    return this.rpc<PreparedReply|null>('prepare_message_reply',{p_job:job.id,p_lease:job.lease_token,p_body:text});
  }
  async prepareDecision(job: MessageJob, decision: AgentDecision) {
    if(technicalFailure(decision.reason)){
      // The existing RPC validates the lease and terminally suppresses this job without an outbound row.
      await this.rpc('prepare_followup_reply',{p_job:job.id,p_lease:job.lease_token,p_body:'',p_action:'suppress',p_sources:[],p_reason:decision.reason,p_summary:null,p_contact:null});
      const jobUpdate=await this.db.from('message_jobs').update({error_code:'ai_reply_unavailable'})
        .eq('tenant_id',job.tenant_id).eq('id',job.id).eq('lease_token',job.lease_token).eq('state','skipped');
      if(jobUpdate.error)throw new Error('AI review status unavailable');
      const message=await this.db.from('messages').select('conversation_id').eq('tenant_id',job.tenant_id).eq('id',job.inbound_message_id).single();
      if(message.error)throw new Error('AI review context unavailable');
      // Conditional server-side metadata update using existing grants. Never overwrite a human takeover or an active issue.
      if(job.automation_epoch!==undefined){
        const review=await this.db.from('conversations').update({attention_state:'waiting',attention_reason:'manual',
          attention_summary:AI_RECOVERY_SUMMARY,attention_message_id:job.inbound_message_id,attention_since:new Date().toISOString(),resolved_at:null})
          .eq('tenant_id',job.tenant_id).eq('id',message.data.conversation_id).eq('automation_epoch',job.automation_epoch)
          .eq('automation_mode','auto').eq('status','open').in('attention_state',['none','resolved']);
        if(review.error)throw new Error('AI review flag unavailable');
      }
      return null;
    }
    return this.rpc<PreparedReply|null>('prepare_followup_reply', { p_job: job.id, p_lease: job.lease_token,
      p_body: decision.text, p_action: decision.action, p_sources: decision.sources, p_reason: decision.reason, p_summary: decision.attentionSummary ?? null, p_contact:decision.followUp??null });
  }
  async complete(job: MessageJob, providerMessageId: string) {
    await this.rpc('complete_message_job',{p_job:job.id,p_lease:job.lease_token,p_provider_id:providerMessageId});
  }
  async fail(job: MessageJob, state: 'failed'|'needs_review', code: string) {
    await this.rpc('fail_message_job',{p_job:job.id,p_lease:job.lease_token,p_state:state,p_code:code});
  }
}
