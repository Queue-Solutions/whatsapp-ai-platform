import type { SupabaseClient } from '@supabase/supabase-js';
export type Conversation = {id:string;automation_mode:'auto'|'human';status:string;last_inbound_at:string;updated_at:string;customer_id:string;name:string};
export type InboxMessage = {id:string;direction:string;body:string|null;message_type:string;delivery_status:string;created_at:string};
export type InboxEvent = {id:string;event_type:string;created_at:string};
/** Reads and mode controls run as the signed-in member and remain protected by RLS. */
export class InboxRepository {
  constructor(private db:SupabaseClient){}
  async conversations(tenant:string):Promise<Conversation[]>{
    const {data,error}=await this.db.from('conversations').select('id,automation_mode,status,last_inbound_at,updated_at,customer_id')
      .eq('tenant_id',tenant).order('last_inbound_at',{ascending:false}).limit(50);
    if(error)throw new Error('Could not load conversations.');
    if(!data.length)return [];
    const customers=await this.db.from('customers').select('id,display_name,whatsapp_id').eq('tenant_id',tenant).in('id',data.map(c=>c.customer_id));
    if(customers.error)throw new Error('Could not load customer details.');
    return data.map(c=>{const customer=customers.data.find(x=>x.id===c.customer_id);return {...c,name:customer?.display_name||`+${customer?.whatsapp_id??'Unknown'}`};});
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
  async mode(conversation:Conversation,mode:'auto'|'human'){
    const {error}=await this.db.rpc('set_conversation_mode',{p_conversation:conversation.id,p_mode:mode,p_expected:conversation.updated_at});
    if(error)throw new Error('Could not change the mode. Refresh the conversation and check your access before trying again.');
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
