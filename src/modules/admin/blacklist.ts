import type {SupabaseClient} from '@supabase/supabase-js';
export type BlockState='pending_review'|'kept'|'removed';
export type BlacklistEntry={customer_id:string;message_id:string;state:BlockState;categories:string[];revision:number;created_at:string;updated_at:string;name:string;phone:string|null;username:string|null;body:string|null;message_type:string};
export const categoryLabel=(category:string)=>({'sexual':'Sexual content','sexual/minors':'Sexual content involving minors','harassment':'Targeted abuse','harassment/threatening':'Threats','hate':'Hateful abuse','hate/threatening':'Hateful threats'}[category]??'Content flagged');
export class BlacklistRepository {
  constructor(private db:SupabaseClient){}
  async list(tenant:string,state:BlockState,limit=50):Promise<BlacklistEntry[]>{
    const blocks=await this.db.from('customer_blacklist').select('customer_id,message_id,state,categories,revision,created_at,updated_at').eq('tenant_id',tenant).eq('state',state).order('updated_at',{ascending:false}).limit(limit);
    if(blocks.error)throw new Error('Could not load the blacklist.');
    if(!blocks.data.length)return [];
    const [customers,messages]=await Promise.all([
      this.db.from('customers').select('id,display_name,whatsapp_id,whatsapp_username').eq('tenant_id',tenant).in('id',blocks.data.map(b=>b.customer_id)),
      this.db.from('messages').select('id,body,message_type').eq('tenant_id',tenant).in('id',blocks.data.map(b=>b.message_id)),
    ]);
    if(customers.error||messages.error)throw new Error('Could not load review details.');
    return blocks.data.map(b=>{const c=customers.data.find(c=>c.id===b.customer_id),m=messages.data.find(m=>m.id===b.message_id);return {...b,name:c?.display_name||'WhatsApp customer',phone:c?.whatsapp_id??null,username:c?.whatsapp_username??null,body:m?.body??null,message_type:m?.message_type??'unknown'};});
  }
  async review(tenant:string,entry:BlacklistEntry,action:'kept'|'removed'){
    const {error}=await this.db.rpc('review_blacklist',{p_tenant:tenant,p_customer:entry.customer_id,p_action:action,p_revision:entry.revision});
    if(error)throw new Error('Could not save the review. Refresh first and check your admin access.');
  }
  async image(message:string){
    const {data,error}=await this.db.auth.getSession();if(error||!data.session)throw new Error('Please sign in again.');
    const response=await fetch(`/api/dashboard/blacklist-image?message=${encodeURIComponent(message)}`,{headers:{Authorization:`Bearer ${data.session.access_token}`},cache:'no-store'});
    if(!response.ok)throw new Error('Image unavailable. It may have expired in WhatsApp.');return response.blob();
  }
}
