import {technicalFailure,AI_RECOVERY_SUMMARY} from '../ai/recovery';
import {boundedHistorySince} from '../ai/conversation-context';
import type { AgentDecision } from '../ai/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppConnection } from '../../config/whatsapp-connections';
import type { DeliveryStatus, IdentityChange, IncomingMessage, MessageContext, MessageJob, MessagingRepository, OutboundEcho, PreparedReply } from './types';

export class SupabaseMessagingRepository implements MessagingRepository {
  constructor(private db: SupabaseClient, private phoneNumberId: string, private pilot?: WhatsAppConnection) {}
  private assertJob(job:MessageJob) {
    if(this.pilot && job.tenant_id!==this.pilot.tenantId)throw new Error('Channel mismatch');
  }
  private async assertChannel() {
    if(!this.pilot)return;
    const {data,error}=await this.db.from('whatsapp_channels').select('tenant_id,mode')
      .eq('phone_number_id',this.phoneNumberId).single();
    if(error||data?.tenant_id!==this.pilot.tenantId||data?.mode!=='pilot')throw new Error('Channel mismatch');
  }
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const {data,error}=await this.db.rpc(name,args);
    if(error) throw new Error(`Database operation failed: ${name}`);
    return data as T;
  }
  private authorized(reply:PreparedReply|null):PreparedReply|null {
    return reply&&this.pilot?{...reply,authorization_scope:'approved_recipient'}:reply;
  }
  async ingest(m: IncomingMessage) {
    if(m.phoneNumberId!==this.phoneNumberId) throw new Error('Channel mismatch');
    await this.assertChannel();
    await this.rpc('ingest_moderated_message',{p_phone:m.phoneNumberId,p_provider_id:m.providerMessageId,
      p_from:m.from,p_user_id:m.userId??null,p_username:m.username??null,p_name:m.displayName??null,p_occurred:m.occurredAt,p_type:m.type,p_body:m.text,p_media_id:m.mediaId??null});
  }
  async isAllowedIdentity(identifier:string,allowed:string[]){
    await this.assertChannel();
    return this.rpc<boolean>('is_allowed_whatsapp_identity',{p_phone:this.phoneNumberId,p_identifier:identifier,p_allowed:allowed});
  }
  async updateIdentity(change:IdentityChange){
    if(change.phoneNumberId!==this.phoneNumberId)throw new Error('Channel mismatch');
    await this.assertChannel();
    await this.rpc('update_whatsapp_identity',{p_phone:change.phoneNumberId,p_provider_id:change.providerMessageId,p_previous:change.previousIdentifier,
      p_new_phone:change.newPhone??null,p_new_user_id:change.newUserId,p_occurred:change.occurredAt});
  }
  async ingestEcho(echo:OutboundEcho){
    if(echo.phoneNumberId!==this.phoneNumberId)throw new Error('Channel mismatch');
    await this.assertChannel();
    await this.rpc('ingest_whatsapp_app_echo',{p_phone:echo.phoneNumberId,p_provider_id:echo.providerMessageId,
      p_to:echo.to,p_user_id:echo.userId??null,p_occurred:echo.occurredAt,p_type:echo.type,p_body:echo.text,p_media_id:echo.mediaId??null});
  }
  async recordStatus(s: DeliveryStatus) {
    if(s.phoneNumberId!==this.phoneNumberId) throw new Error('Channel mismatch');
    await this.assertChannel();
    await this.rpc('record_whatsapp_status',{p_phone:s.phoneNumberId,p_provider_id:s.providerMessageId,
      p_status:s.status,p_occurred:s.occurredAt,p_code:s.errorCode??null});
  }
  async claim() {
    await this.assertChannel();
    await this.rpc('expire_manual_replies', {});
    if(this.pilot&&!this.pilot.sendEnabled){
      await this.rpc('recover_pilot_sends',{p_phone:this.phoneNumberId,p_tenant:this.pilot.tenantId});
      return null;
    }
    const rows=await this.rpc<MessageJob[]>('claim_message_job',{p_phone:this.phoneNumberId});
    if(rows[0])this.assertJob(rows[0]);
    return rows[0]??null;
  }
  async context(job: MessageJob): Promise<MessageContext> {
    this.assertJob(job);
    const {data,error}=await this.db.from('messages').select('tenant_id,conversation_id,channel_id,body,message_type,media_id,moderation_state,occurred_at,created_at')
      .eq('id',job.inbound_message_id).eq('tenant_id',job.tenant_id).single();
    if(error || !data) throw new Error('Message context unavailable');
    const conversation=await this.db.from('conversations').select('customer_id,followup_purpose,followup_role,automation_mode,automation_epoch,status,last_inbound_at,context_reset_at,followup_state,followup_name,followup_phone,attention_state,attention_reason,attention_summary')
      .eq('tenant_id',job.tenant_id).eq('id',data.conversation_id).single();
    if(conversation.error||!conversation.data)throw new Error('Message context unavailable');
    const c=conversation.data;
    const historyPromise=this.rpc<import('../ai/conversation-context').HistoryRow[]>('message_history_before',{
      p_tenant:job.tenant_id,p_message:job.inbound_message_id,p_limit:16,
    });
    const [channel,history]=await Promise.all([
      this.db.from('whatsapp_channels').select('enabled,mode,phone_number_id,assistant_scope').eq('tenant_id',job.tenant_id).eq('id',data.channel_id).single(),
      historyPromise,
    ]);
    if(channel.error)throw new Error('Message context unavailable');
    const ch=channel.data;
    if(this.pilot&&(ch.mode!=='pilot'||ch.phone_number_id!==this.phoneNumberId))throw new Error('Channel mismatch');
    const selected=ch.assistant_scope==='selected'?await this.db.from('assistant_selected_conversations').select('conversation_id')
      .eq('tenant_id',job.tenant_id).eq('channel_id',data.channel_id).eq('conversation_id',data.conversation_id).maybeSingle():null;
    if(selected?.error)throw new Error('Assistant availability unavailable');
    const assistantAvailable=ch.assistant_scope==='all'||(ch.assistant_scope==='selected'&&!!selected?.data);
    const block=await this.db.from('customer_blacklist').select('state').eq('tenant_id',job.tenant_id).eq('customer_id',c.customer_id).maybeSingle();
    if(block.error)throw new Error('Block status unavailable');
    const blocked=!!block.data&&block.data.state!=='removed';
    const modeAllowed=this.pilot?ch.mode==='pilot'&&this.pilot.sendEnabled&&ch.assistant_scope==='selected':ch.mode==='test';
    const eligible = assistantAvailable && !blocked && c.automation_mode === 'auto' && c.status === 'open' && ch.enabled && modeAllowed
      && job.automation_epoch === c.automation_epoch
      && ch.phone_number_id === this.phoneNumberId && Date.parse(c.last_inbound_at) >= Date.now() - (23*60+55)*60000;
    const activeFollowUp=['waiting','in_progress'].includes(c.attention_state)&&['collecting','ready','declined'].includes(c.followup_state);
    return {tenantId:data.tenant_id,conversationId:data.conversation_id,text:data.body,type:data.message_type,mediaId:data.media_id??undefined,moderationState:data.moderation_state,blocked,eligible,history:boundedHistorySince(history,c.context_reset_at),
      followUp:activeFollowUp?{state:c.followup_state as 'collecting'|'ready'|'declined',purpose:c.followup_purpose==='career'?'career':undefined,role:c.followup_role,name:c.followup_name,phone:c.followup_phone,
        reason:c.attention_reason==='knowledge_gap'?'missing_business_information':c.attention_reason,summary:c.attention_summary}:undefined};
  }
  moderate(job:MessageJob,result:import('../moderation/provider').ModerationResult){
    this.assertJob(job);
    return this.rpc<boolean>('finish_content_check',{p_job:job.id,p_lease:job.lease_token,p_state:result.state,p_categories:result.categories});
  }
  prepare(job: MessageJob, text: string) {
    this.assertJob(job);
    return this.rpc<PreparedReply|null>('prepare_message_reply',{p_job:job.id,p_lease:job.lease_token,p_body:text}).then(reply=>this.authorized(reply));
  }
  async prepareDecision(job: MessageJob, decision: AgentDecision) {
    this.assertJob(job);
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
    if(decision.reason==='live_price_information'){
      return this.rpc<PreparedReply|null>('prepare_policy_reply',{p_job:job.id,p_lease:job.lease_token,p_body:decision.text,p_reason:decision.reason}).then(reply=>this.authorized(reply));
    }
    return this.rpc<PreparedReply|null>('prepare_followup_reply', { p_job: job.id, p_lease: job.lease_token,
      p_body: decision.text, p_action: decision.action, p_sources: decision.sources, p_reason: decision.reason, p_summary: decision.attentionSummary ?? null, p_contact:decision.followUp??null }).then(reply=>this.authorized(reply));
  }
  recover(job:MessageJob,code:string){
    this.assertJob(job);
    return this.rpc<'pending'|'failed'>('recover_processing_job',{p_job:job.id,p_lease:job.lease_token,p_code:code});
  }
  async complete(job: MessageJob, providerMessageId: string) {
    this.assertJob(job);
    await this.rpc('complete_message_job',{p_job:job.id,p_lease:job.lease_token,p_provider_id:providerMessageId});
  }
  async fail(job: MessageJob, state: 'failed'|'needs_review', code: string) {
    this.assertJob(job);
    await this.rpc('fail_message_job',{p_job:job.id,p_lease:job.lease_token,p_state:state,p_code:code});
  }
}
