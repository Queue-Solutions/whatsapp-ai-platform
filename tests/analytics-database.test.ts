import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';

const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',outsider='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const customer1='10000000-0000-4000-8000-000000000001',customer2='10000000-0000-4000-8000-000000000002',customer3='10000000-0000-4000-8000-000000000003';
const conversation1='20000000-0000-4000-8000-000000000001',conversation2='20000000-0000-4000-8000-000000000002',conversation3='20000000-0000-4000-8000-000000000003';
const message1='30000000-0000-4000-8000-000000000001',message2='30000000-0000-4000-8000-000000000002',message3='30000000-0000-4000-8000-000000000003',outsideMessage='30000000-0000-4000-8000-000000000004';

describe('chat analytics database boundary',()=>{
  let db:PGlite;
  const rows=async<T=Record<string,unknown>>(sql:string,args:unknown[]=[])=>(await db.query<T>(sql,args)).rows;
  async function asUser(user:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');}
  async function report(t=tenant,from='2026-09-01T00:00:00Z',to='2026-10-01T00:00:00Z'){
    return (await rows<{value:{summary:Record<string,number>;customers:Array<Record<string,unknown>>;recommendations:Array<Record<string,unknown>>;series:Array<Record<string,unknown>>}}>('select public.get_chat_analytics($1,$2,$3,$4) value',[t,from,to,'day']))[0].value;
  }
  async function recommendations(t=tenant){return (await rows<{value:Array<Record<string,unknown>>}>('select public.get_ai_recommendations($1) value',[t]))[0].value;}
  async function insight(request:string,message:string,decision:Record<string,unknown>){
    await db.query("insert into public.ai_requests(tenant_id,request_key,purpose,model,prompt_version,state,reserved_nano,decision,created_at,completed_at) values($1,$2,'whatsapp','gpt-4.1-mini-2025-04-14','test','completed',10640000,$3,'2026-09-20T12:01:00Z','2026-09-20T12:01:00Z')",[tenant,`message:${message}:${request}`,JSON.stringify(decision)]);
  }
  beforeAll(async()=>{db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");for(const file of(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));});
  afterAll(async()=>{await db.close();});
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.tenants,auth.users cascade;');
    await db.query("insert into public.tenants(id,name,slug) values($1,'Demo','demo'),($2,'Other','other')",[tenant,other]);
    await db.query("insert into public.whatsapp_channels(id,tenant_id,phone_number_id) values('40000000-0000-4000-8000-000000000001',$1,'9001'),('40000000-0000-4000-8000-000000000002',$2,'9002')",[tenant,other]);
    await db.query('insert into auth.users values($1),($2)',[owner,outsider]);await db.query("insert into public.tenant_memberships values($1,$2,'owner'),($3,$4,'owner')",[tenant,owner,other,outsider]);
    await db.query("insert into public.customers(id,tenant_id,whatsapp_id,display_name) values($1,$2,'201000000001','=Formula Name'),($3,$2,'201000000002','Maya'),($4,$5,'201000000003','Other customer')",[customer1,tenant,customer2,customer3,other]);
    await db.query("insert into public.conversations(id,tenant_id,customer_id,channel_id,last_inbound_at) values($1,$2,$3,'40000000-0000-4000-8000-000000000001','2026-09-20T12:00:00Z'),($4,$2,$5,'40000000-0000-4000-8000-000000000001','2026-09-21T12:00:00Z'),($6,$7,$8,'40000000-0000-4000-8000-000000000002','2026-09-20T12:00:00Z')",[conversation1,tenant,customer1,conversation2,customer2,conversation3,other,customer3]);
    await db.query("insert into public.messages(id,tenant_id,conversation_id,channel_id,direction,provider_message_id,message_type,body,delivery_status,occurred_at,moderation_state) values($1,$2,$3,'40000000-0000-4000-8000-000000000001','inbound','m1','text','private one','received','2026-09-20T12:00:00Z','clear'),($4,$2,$5,'40000000-0000-4000-8000-000000000001','inbound','m2','text','private two','received','2026-09-21T12:00:00Z','flagged'),($6,$7,$8,'40000000-0000-4000-8000-000000000002','inbound','m3','text','private other','received','2026-09-20T12:00:00Z','clear'),($9,$2,$3,'40000000-0000-4000-8000-000000000001','inbound','m4','text','outside range','received','2026-10-01T00:00:00Z','clear')",[message1,tenant,conversation1,message2,conversation2,message3,other,conversation3,outsideMessage]);
    await db.query("insert into public.conversation_events(tenant_id,conversation_id,event_type,created_at) values($1,$2,'complaint','2026-09-20T13:00:00Z'),($1,$2,'complaint','2026-09-20T14:00:00Z'),($1,$3,'human_requested','2026-09-21T13:00:00Z'),($4,$5,'complaint','2026-09-20T13:00:00Z')",[tenant,conversation1,conversation2,other,conversation3]);
    const base={kind:'intent_classification',catalogFingerprint:'fp',intent:'business_question',confidence:.99,language:'en',product:'unknown',branchMode:'none',branchDetail:'none',branchLabels:[],originEvidence:'',originQuery:'',normalizedQuery:'Do you offer gift wrapping?',summary:'',risk:'spam_or_fraud'};
    await insight('intent:fp',message1,base);await insight('final',message1,{text:'',action:'unavailable',reason:'missing_business_information',sources:[],attentionSummary:'Gift wrapping is not confirmed.'});
    await insight('intent:fp',message2,{...base,risk:'none'});
  });
  it('counts unique customers, keeps event counts in detail and excludes the upper date boundary',async()=>{
    await asUser(owner);const data=await report();
    expect(data.summary).toMatchObject({customers:2,chats:2,inboundMessages:2,spamOrFraud:1,abuseOrSexualHarassment:1,complaints:1,contactRequests:1,knowledgeGaps:1});
    expect(data.customers).toHaveLength(2);expect(data.customers.find(row=>row.id===customer1)).toMatchObject({complaints:2,spamOrFraud:1,knowledgeGaps:1});
    expect(data.series).toHaveLength(2);
  });
  it('creates FAQ opportunities only from turns that actually became knowledge gaps',async()=>{
    await asUser(owner);expect(await rows('select message_id,topic,risk,is_knowledge_gap from public.message_insights order by message_id')).toEqual([
      {message_id:message1,topic:'Do you offer gift wrapping?',risk:'spam_or_fraud',is_knowledge_gap:true},
      {message_id:message2,topic:'Do you offer gift wrapping?',risk:'none',is_knowledge_gap:false},
    ]);
    await asUser(owner);expect(await recommendations()).toEqual([expect.objectContaining({kind:'faq_gap',topic:'Do you offer gift wrapping?',mentions:1,customers:1,reason:expect.stringContaining('personal follow-up')})]);
  });
  it('removes a topic from recommendations when a matching published FAQ exists',async()=>{
    await db.query("insert into public.faqs(tenant_id,question,answer,is_published) values($1,'Do you offer gift wrapping?','Yes.',true)",[tenant]);await asUser(owner);
    expect(await recommendations()).toEqual([]);expect((await report()).recommendations).toEqual([]);
  });
  it('resets current recommendations, ignores repeated answered topics and allows a new gap to create one',async()=>{
    await asUser(owner);expect(await recommendations()).toEqual([expect.objectContaining({topic:'Do you offer gift wrapping?',mentions:1})]);
    await rows('select public.reset_ai_recommendations($1)',[tenant]);
    expect(await recommendations()).toEqual([]);expect(await rows('select count(*)::int count from public.message_insights where tenant_id=$1',[tenant])).toEqual([{count:2}]);
    await db.exec('reset role');
    await db.query("insert into public.messages(id,tenant_id,conversation_id,channel_id,direction,provider_message_id,message_type,body,delivery_status,occurred_at,moderation_state) values('30000000-0000-4000-8000-000000000005',$1,$2,'40000000-0000-4000-8000-000000000001','inbound','new-1','text','new private one','received',clock_timestamp()+interval '1 second','clear'),('30000000-0000-4000-8000-000000000006',$1,$3,'40000000-0000-4000-8000-000000000001','inbound','new-2','text','new private two','received',clock_timestamp()+interval '1 second','clear')",[tenant,conversation1,conversation2]);
    await db.query("insert into public.message_insights(tenant_id,message_id,conversation_id,intent,topic,language) values($1,'30000000-0000-4000-8000-000000000005',$2,'business_question','Do you provide engraving?','en'),($1,'30000000-0000-4000-8000-000000000006',$3,'business_question','Do you provide engraving?','en')",[tenant,conversation1,conversation2]);
    await asUser(owner);expect(await recommendations()).toEqual([]);
    await db.exec('reset role');await db.query("update public.message_insights set is_knowledge_gap=true,summary='Engraving is not confirmed.' where tenant_id=$1 and message_id='30000000-0000-4000-8000-000000000006'",[tenant]);
    await asUser(owner);expect(await recommendations()).toEqual([expect.objectContaining({topic:'Do you provide engraving?',mentions:1,customers:1})]);
  });
  it('enforces tenant membership in the RPC and RLS-protected insight rows',async()=>{
    await asUser(owner);expect(await rows('select tenant_id from public.message_insights')).toHaveLength(2);await expect(report(other)).rejects.toThrow('access denied');
    await asUser(outsider);expect(await rows('select tenant_id from public.message_insights')).toEqual([]);await expect(report(tenant)).rejects.toThrow('access denied');await expect(recommendations(tenant)).rejects.toThrow('access denied');await expect(rows('select public.reset_ai_recommendations($1)',[tenant])).rejects.toThrow('access denied');
  });
});
