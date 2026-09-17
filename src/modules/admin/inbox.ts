import type { SupabaseClient } from '@supabase/supabase-js';
export type InboxFilter = 'all' | 'attention' | 'complaints' | 'resolved';
export type AttentionAction = 'reply' | 'resolve' | 'resume' | 'flag' | 'complaint' | 'remove_complaint';
export type Conversation = {id:string;automation_mode:'auto'|'human';status:string;last_inbound_at:string;updated_at:string;customer_id:string;name:string;phone:string|null;username:string|null;
  attention_state:'none'|'waiting'|'in_progress'|'resolved';attention_reason:string|null;attention_summary:string;attention_since:string|null;resolved_at:string|null;is_complaint:boolean;attention_message_id:string|null;followup_state:'none'|'collecting'|'ready'|'declined';followup_name:string|null;followup_phone:string|null;followup_purpose?:string;followup_role?:string|null;blocked?:boolean};
export type InboxCounts = Record<InboxFilter,number>;
export const attentionReason = (reason:string|null) => ({career_application:'Job enquiry',moderation_review:'Content check needs review',human_requested:'Requested a person',complaint:'Complaint',manual:'Flagged by you',customer_follow_up:'Customer followed up',knowledge_gap:'Missing business information'}[reason??'']??'Personal attention');
export function conversationStateLabel(c:Pick<Conversation,'attention_state'|'automation_mode'|'blocked'>) {
  if(c.blocked)return 'Blacklisted · Replies blocked';
  if(c.attention_state==='resolved')return c.automation_mode==='auto'?'Resolved · Assistant on':'Resolved · Assistant paused';
  if(c.attention_state==='in_progress')return 'Replying personally';
  if(c.attention_state==='waiting')return c.automation_mode==='auto'?'Needs review · Assistant on':'Needs you · Assistant paused';
  return c.automation_mode==='auto'?'Assistant on':'Assistant paused';
}
export function waitingLabel(since:string|null,now=Date.now()) {
  if(!since)return 'Needs attention';
  const minutes=Math.max(0,Math.floor((now-Date.parse(since))/60000));
  return minutes<1?'Waiting just now':minutes<60?`Waiting ${minutes} min`:minutes<1440?`Waiting ${Math.floor(minutes/60)}h ${minutes%60}m`:`Waiting ${Math.floor(minutes/1440)}d ${Math.floor(minutes%1440/60)}h`;
}

export type InboxMessage = {id:string;direction:string;body:string|null;message_type:string;delivery_status:string;created_at:string};
export type InboxEvent = {id:string;event_type:string;created_at:string};
/** Reads and mode controls run as the signed-in member and remain protected by RLS. */
export class InboxRepository {
  constructor(private db:SupabaseClient){}
  async counts(tenant:string):Promise<InboxCounts>{
    const base=()=>this.db.from('conversations').select('id',{count:'exact',head:true}).eq('tenant_id',tenant);
    const rows=await Promise.all([base(),base().in('attention_state',['waiting','in_progress']),base().eq('is_complaint',true),base().eq('attention_state','resolved')]);
    if(rows.some(r=>r.error))throw new Error('Could not load inbox counts.');
    return {all:rows[0].count??0,attention:rows[1].count??0,complaints:rows[2].count??0,resolved:rows[3].count??0};
  }
  async conversations(tenant:string,filter:InboxFilter='all',limit=50):Promise<Conversation[]>{
    let query=this.db.from('conversations').select('id,automation_mode,status,last_inbound_at,updated_at,customer_id,attention_state,attention_reason,attention_summary,attention_since,resolved_at,is_complaint,attention_message_id,followup_state,followup_name,followup_phone,followup_purpose,followup_role').eq('tenant_id',tenant);
    if(filter==='attention')query=query.in('attention_state',['waiting','in_progress']);
    if(filter==='complaints')query=query.eq('is_complaint',true);
    if(filter==='resolved')query=query.eq('attention_state','resolved');
    const {data,error}=await query.order(filter==='attention'?'attention_since':'last_inbound_at',{ascending:filter==='attention'}).order('id').limit(limit);
    if(error)throw new Error('Could not load conversations.');
    if(!data.length)return [];
    const customers=await this.db.from('customers').select('id,display_name,whatsapp_id,whatsapp_username').eq('tenant_id',tenant).in('id',data.map(c=>c.customer_id));
    if(customers.error)throw new Error('Could not load customer details.');
    const blocks=await this.db.from('customer_blacklist').select('customer_id,state').eq('tenant_id',tenant).in('customer_id',data.map(c=>c.customer_id));
    if(blocks.error)throw new Error('Could not load block status.');
    return data.map(c=>{const customer=customers.data.find(x=>x.id===c.customer_id);return {...c,blocked:blocks.data.some(b=>b.customer_id===c.customer_id&&b.state!=='removed'),name:customer?.display_name||(customer?.whatsapp_username?`@${customer.whatsapp_username}`:'WhatsApp customer'),phone:customer?.whatsapp_id??null,username:customer?.whatsapp_username??null};});
  }
  async messages(tenant:string,conversation:string,limit=100):Promise<InboxMessage[]>{
    const {data,error}=await this.db.from('messages').select('id,direction,body,message_type,delivery_status,created_at')
      .eq('tenant_id',tenant).eq('conversation_id',conversation).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit);
    if(error)throw new Error('Could not load messages.');return data.reverse();
  }
  async events(tenant:string,conversation:string):Promise<InboxEvent[]>{
    const {data,error}=await this.db.from('conversation_events').select('id,event_type,created_at')
      .eq('tenant_id',tenant).eq('conversation_id',conversation).order('created_at',{ascending:false}).limit(10);
    if(error)throw new Error('Could not load activity.');return data;
  }
  async attentionMessage(tenant:string,conversation:string,id:string):Promise<InboxMessage|null>{
    const {data,error}=await this.db.from('messages').select('id,direction,body,message_type,delivery_status,created_at')
      .eq('tenant_id',tenant).eq('conversation_id',conversation).eq('id',id).eq('direction','inbound').maybeSingle();
    if(error)throw new Error('Could not load the unanswered question. Refresh and try again.');
    return data;
  }
  async attention(conversation:Conversation,action:AttentionAction){
    const {error}=await this.db.rpc('manage_conversation_attention',{p_conversation:conversation.id,p_action:action,p_expected:conversation.updated_at});
    if(error)throw new Error('Could not update this conversation. Refresh it and check your access before trying again.');
  }
  async send(conversationId:string,requestId:string,text:string){
    const {data,error}=await this.db.auth.getSession();if(error||!data.session)throw new Error('Please sign in again.');
    const response=await fetch('/api/dashboard/reply',{method:'POST',headers:{Authorization:`Bearer ${data.session.access_token}`,'Content-Type':'application/json'},
      body:JSON.stringify({conversationId,requestId,text}),signal:AbortSignal.timeout(45000)});
    const result=await response.json();
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'Could not send. Refresh to check the reply status.');
    return result.state as 'sent'|'sending'|'failed'|'needs_review';
  }
}
