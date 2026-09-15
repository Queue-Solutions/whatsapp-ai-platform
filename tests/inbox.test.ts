import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {handleManualReply,type ManualReplyRepository} from '../src/modules/admin/manual-reply';
import {SendError} from '../src/modules/whatsapp/sender';
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',viewer='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',agent='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const requestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
describe('inbox PostgreSQL boundaries',()=>{
  let db:PGlite;let conversation:string;
  async function rows<T=Record<string,unknown>>(sql:string,args:unknown[]=[]){return(await db.query<T>(sql,args)).rows;}
  async function asUser(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
  async function mode(value:string,id=conversation){const [c]=await rows<{version:string}>('select updated_at::text as version from public.conversations where id=$1',[id]);return db.query('select public.set_conversation_mode($1,$2,$3)',[id,value,c?.version??new Date().toISOString()]);}
  async function manual(overrides:{actor?:string;id?:string;body?:string;phone?:string;allowed?:string[];conversation?:string}={}){
    return(await rows<{v:{state:string;reply?:{outbound_id:string}}}>('select public.prepare_manual_reply($1,$2,$3,$4,$5,$6) as v',[overrides.actor??owner,overrides.conversation??conversation,overrides.id??requestId,overrides.body??'Synthetic staff reply',overrides.phone??'9001',overrides.allowed??['201000000001']]))[0].v;
  }
  async function claim(){return(await rows<{id:string;lease_token:string;automation_epoch:number}>("select * from public.claim_message_job('9001')"))[0];}
  beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const file of ['202609120001_foundation.sql','202609120002_bounded_ai.sql','202609130001_inbox.sql','202609160001_inbox_attention.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  });
  afterAll(async()=>{await db?.close();});
  beforeEach(async()=>{await db.exec('reset role;truncate public.tenants,auth.users cascade;');
    await db.query("insert into public.tenants(id,name,slug) values($1,'Development','development'),($2,'Other','other')",[tenant,other]);
    await db.query('insert into auth.users values($1),($2),($3)',[owner,viewer,agent]);
    await db.query("insert into public.tenant_memberships values($1,$2,'owner'),($1,$3,'viewer'),($1,$4,'agent')",[tenant,owner,viewer,agent]);
    await db.query("insert into public.whatsapp_channels(tenant_id,phone_number_id) values($1,'9001'),($2,'9002')",[tenant,other]);
    await db.exec("select public.ingest_whatsapp_message('9001','fixture','201000000001',null,now(),'text','Synthetic test question');select public.ingest_whatsapp_message('9002','other-fixture','201000000002',null,now(),'text','Other private fixture');");
    conversation=(await rows<{id:string}>('select id from public.conversations where tenant_id=$1',[tenant]))[0].id;
  });
  it('limits reads and audited mode changes to the authenticated tenant and permitted roles',async()=>{
    await asUser(viewer);expect(await rows('select id from public.conversations')).toHaveLength(1);expect(await rows('select id from public.messages')).toHaveLength(1);
    await expect(mode('human')).rejects.toThrow('access denied');await expect(db.exec("update public.conversations set automation_mode='human'")).rejects.toThrow();
    await asUser(agent);await mode('human');expect(await rows('select id from public.conversation_events')).toHaveLength(1);
    await db.exec('reset role');const otherConversation=(await rows<{id:string}>('select id from public.conversations where tenant_id=$1',[other]))[0].id;
    await asUser(owner);await expect(mode('auto',otherConversation)).rejects.toThrow('access denied');await expect(db.query('select public.set_conversation_mode($1,$2,$3)',[conversation,'auto','2000-01-01'])).rejects.toThrow('changed');
    await mode('auto');expect(await rows('select id from public.conversation_events')).toHaveLength(2);
    await expect(db.exec('delete from public.conversation_events')).rejects.toThrow();await db.exec('set role anon');await expect(mode('human')).rejects.toThrow();
  });
  it('invalidates pending and in-flight generation across pause/resume while allowing new messages',async()=>{
    const old=await claim();await asUser(owner);await mode('human');await mode('auto');await db.exec('reset role');
    const result=await rows<{v:unknown}>("select public.prepare_ai_reply($1,$2,'Hi! How can I help you?','clarify','[]') as v",[old.id,old.lease_token]);expect(result[0].v).toBeNull();
    await asUser(owner);await mode('human');await db.exec('reset role');
    await db.exec("select public.ingest_whatsapp_message('9001','during-pause','201000000001',null,now(),'text','Synthetic waiting message')");
    await asUser(owner);await mode('auto');await db.exec('reset role');const waiting=await claim();
    expect((await rows<{v:unknown}>("select public.prepare_message_reply($1,$2,'Old reply') as v",[waiting.id,waiting.lease_token]))[0].v).toBeNull();
    await db.exec("select public.ingest_whatsapp_message('9001','after-resume','201000000001',null,now(),'text','Hi')");const fresh=await claim();expect(fresh.automation_epoch).toBe(4);
    expect((await rows<{v:unknown}>("select public.prepare_ai_reply($1,$2,'Hi! How can I help you?','clarify','[]') as v",[fresh.id,fresh.lease_token]))[0].v).not.toBeNull();
  });
  it('keeps source requirements for factual answers while allowing fixed nonfactual greetings',async()=>{
    const job=await claim();await expect(db.query("select public.prepare_ai_reply($1,$2,'Invented hours','answer','[]')",[job.id,job.lease_token])).rejects.toThrow('Ungrounded');
  });
  it('requires human mode, allowed test recipient, fresh service window and a permitted actor for manual sending',async()=>{
    await expect(manual()).rejects.toThrow('Pause');await asUser(owner);await mode('human');await db.exec('reset role');
    await expect(manual({actor:viewer})).rejects.toThrow('access denied');await expect(manual({phone:'9002'})).rejects.toThrow('Test guard');await expect(manual({allowed:[]})).rejects.toThrow('Test guard');
    await db.exec('set role authenticated');await expect(manual()).rejects.toThrow();await db.exec('reset role');
    await db.query("update public.conversations set last_inbound_at=now()-interval '24 hours' where id=$1",[conversation]);await expect(manual()).rejects.toThrow('window expired');
    expect(await rows('select id from public.manual_reply_requests')).toHaveLength(0);
  });
  it('durably deduplicates concurrent manual requests and rejects reuse with different content',async()=>{
    await asUser(owner);await mode('human');await db.exec('reset role');
    const results=await Promise.all([manual(),manual()]);expect(results.map(x=>x.state).sort()).toEqual(['new','sending']);
    expect(await rows('select id from public.manual_reply_requests')).toHaveLength(1);await expect(manual({body:'Changed draft'})).rejects.toThrow('identity conflict');
    await db.query("select public.finish_manual_reply($1,'needs_review',null,'network_outcome_unknown')",[requestId]);expect((await manual()).state).toBe('needs_review');
    expect((await rows<{delivery_status:string}>('select delivery_status from public.messages where id=(select outbound_id from public.manual_reply_requests)'))[0].delivery_status).toBe('needs_review');
  });
  it('preserves delivery receipts arriving before the manual send response',async()=>{
    await asUser(owner);await mode('human');await db.exec('reset role');await manual();
    await db.exec("select public.record_whatsapp_status('9001','manual-provider','delivered',now(),null)");
    await db.query("select public.finish_manual_reply($1,'sent','manual-provider',null)",[requestId]);
    await db.query("select public.finish_manual_reply($1,'failed',null,'late-error')",[requestId]);
    expect((await rows<{delivery_status:string}>('select delivery_status from public.messages where provider_message_id=\'manual-provider\''))[0].delivery_status).toBe('delivered');
  });
  async function attention(action:string,id=conversation){
    const [c]=await rows<{version:string}>('select updated_at::text as version from public.conversations where id=$1',[id]);
    return db.query('select public.manage_conversation_attention($1,$2,$3)',[id,action,c?.version??new Date().toISOString()]);
  }
  it('tracks a complaint through personal reply and resolution without resuming the assistant',async()=>{
    await asUser(owner);await attention('complaint');
    expect((await rows('select attention_state,is_complaint,automation_mode from public.conversations'))[0]).toMatchObject({attention_state:'waiting',is_complaint:true,automation_mode:'human'});
    await attention('reply');expect((await rows('select attention_state from public.conversations'))[0]).toMatchObject({attention_state:'in_progress'});
    await attention('resolve');expect((await rows('select attention_state,automation_mode,resolved_at from public.conversations'))[0]).toMatchObject({attention_state:'resolved',automation_mode:'human',resolved_at:expect.anything()});
    await db.exec('reset role');await expect(manual()).rejects.toThrow('Pause');
    await asUser(owner);await attention('remove_complaint');
    expect((await rows('select is_complaint,attention_state,automation_mode from public.conversations'))[0]).toMatchObject({is_complaint:false,attention_state:'resolved',automation_mode:'human'});
    await attention('resume');expect((await rows('select attention_state,automation_mode from public.conversations'))[0]).toMatchObject({attention_state:'none',automation_mode:'auto'});
    expect(await rows('select id from public.conversation_events')).toHaveLength(5);
  });
  it('denies attention edits by viewers, anonymous callers and other tenants, including stale requests',async()=>{
    await db.exec('reset role');const id=(await rows<{id:string}>('select id from public.conversations where tenant_id=$1',[other]))[0].id;
    await asUser(viewer);await expect(attention('complaint')).rejects.toThrow('access denied');
    await asUser(owner);await expect(attention('resolve',id)).rejects.toThrow('access denied');
    await expect(db.query("select public.manage_conversation_attention($1,'resolve','2000-01-01')",[conversation])).rejects.toThrow('changed');
    await expect(attention('invented')).rejects.toThrow('Invalid');
    await expect(db.exec("update public.conversations set is_complaint=true")).rejects.toThrow();
    await db.exec('set role anon');await expect(db.query("select public.manage_conversation_attention($1,'flag',now())",[conversation])).rejects.toThrow();
    await db.exec('reset role');expect(await rows("select id from public.conversations where attention_state<>'none'")).toHaveLength(0);
  });
  it('reopens resolved conversations only on new inbound messages, keeping automation paused and duplicate events harmless',async()=>{
    await asUser(owner);await attention('resolve');await db.exec('reset role');
    await db.exec("select public.ingest_whatsapp_message('9001','fixture','201000000001',null,now(),'text','Duplicate')");
    expect((await rows('select attention_state from public.conversations where id=$1',[conversation]))[0]).toMatchObject({attention_state:'resolved'});
    await db.exec("select public.ingest_whatsapp_message('9001','old-delayed','201000000001',null,now()-interval '1 day','text','Old delayed message')");
    expect((await rows('select attention_state from public.conversations where id=$1',[conversation]))[0]).toMatchObject({attention_state:'resolved'});
    await db.exec("select public.ingest_whatsapp_message('9001','follow-up','201000000001',null,now(),'text','I still need help')");
    expect((await rows('select attention_state,attention_reason,automation_mode from public.conversations where id=$1',[conversation]))[0]).toMatchObject({attention_state:'waiting',attention_reason:'customer_follow_up',automation_mode:'human'});
    await asUser(owner);await attention('resolve');await db.exec('reset role');
    await db.exec("select public.ingest_whatsapp_message('9001','follow-up','201000000001',null,now(),'text','Redelivery')");
    expect((await rows('select attention_state from public.conversations where id=$1',[conversation]))[0]).toMatchObject({attention_state:'resolved'});
    expect(await rows("select id from public.conversation_events where event_type='customer_follow_up'")).toHaveLength(1);
  });
  it('atomically flags automatic complaints, pauses future jobs and preserves the queue when acknowledgment delivery is uncertain',async()=>{
    const job=await claim();
    const reply=(await rows<{v:unknown}>("select public.prepare_inbox_reply($1,$2,'I will pause automated replies.','handoff','[]','complaint') as v",[job.id,job.lease_token]))[0].v;
    expect(reply).not.toBeNull();
    expect((await rows('select attention_state,is_complaint,automation_mode,automation_epoch from public.conversations where id=$1',[conversation]))[0]).toMatchObject({attention_state:'waiting',is_complaint:true,automation_mode:'human',automation_epoch:1});
    await db.query("select public.fail_message_job($1,$2,'needs_review','network_outcome_unknown')",[job.id,job.lease_token]);
    expect((await rows('select attention_state from public.conversations where id=$1',[conversation]))[0]).toMatchObject({attention_state:'waiting'});
    await expect(db.query("select public.prepare_inbox_reply($1,$2,'Again','handoff','[]','complaint')",[job.id,job.lease_token])).rejects.toThrow('lease');
    expect(await rows("select id from public.conversation_events where event_type='complaint'")).toHaveLength(1);
    expect(await rows("select id from public.conversations where tenant_id=$1 and attention_state<>'none'",[other])).toHaveLength(0);
  });
  it('does not create attention cases from stale work after personal takeover or resume',async()=>{
    const job=await claim();await asUser(owner);await attention('reply');await attention('resume');await db.exec('reset role');
    expect((await rows<{v:unknown}>("select public.prepare_inbox_reply($1,$2,'Old complaint','handoff','[]','complaint') as v",[job.id,job.lease_token]))[0].v).toBeNull();
    expect((await rows('select attention_state,is_complaint from public.conversations where id=$1',[conversation]))[0]).toMatchObject({attention_state:'none',is_complaint:false});
  });
  it('marks abandoned manual intents uncertain without retrying them',async()=>{
    await asUser(owner);await mode('human');await db.exec('reset role');await manual();await db.exec("update public.manual_reply_requests set created_at=now()-interval '3 minutes';select public.expire_manual_replies();");
    expect((await manual()).state).toBe('needs_review');expect(await rows("select id from public.messages where delivery_status='needs_review'")).toHaveLength(1);
  });
});

describe('manual reply HTTP boundary',()=>{
  const input={conversationId:tenant,requestId,text:'Synthetic reply'};
  const request=(body:unknown=input,auth=true)=>new Request('https://test/api/dashboard/reply',{method:'POST',headers:auth?{Authorization:'Bearer fake-test-session'}:{},body:JSON.stringify(body)});
  const prepared={outbound_id:'out',phone_number_id:'9001',recipient:'201000000001',body:'Synthetic reply'};
  it('authenticates before constructing privileged services and rejects body overrides',async()=>{
    const services=vi.fn();const authenticate=vi.fn(async()=>owner);
    expect((await handleManualReply(request(input,false),{authenticate,services})).status).toBe(401);expect(authenticate).not.toHaveBeenCalled();
    expect((await handleManualReply(request({...input,tenantId:other}),{authenticate,services})).status).toBe(400);expect(services).not.toHaveBeenCalled();
  });
  it('never resends an existing durable intent',async()=>{
    const sender={send:vi.fn()};const repository={prepare:vi.fn(async()=>({state:'needs_review' as const})),finish:vi.fn()};
    const response=await handleManualReply(request(),{authenticate:async()=>owner,services:()=>({repository,sender})});
    expect(await response.json()).toEqual({state:'needs_review'});expect(sender.send).not.toHaveBeenCalled();
  });
  it('records network and commit uncertainty without automatic send retries',async()=>{
    for(const error of [new SendError(true,'network_outcome_unknown'),new Error('private provider detail')]){
      const repository:ManualReplyRepository={prepare:vi.fn(async()=>({state:'new' as const,reply:prepared})),finish:vi.fn()};const sender={send:vi.fn().mockRejectedValue(error)};
      const response=await handleManualReply(request(),{authenticate:async()=>owner,services:()=>({repository,sender})});expect(await response.json()).toEqual({state:'needs_review'});expect(sender.send).toHaveBeenCalledOnce();expect(repository.finish).toHaveBeenCalledWith(requestId,'needs_review',null,expect.any(String));
    }
    const finish=vi.fn().mockRejectedValue(new Error('DB unavailable'));const send=vi.fn().mockResolvedValue('provider');
    const response=await handleManualReply(request(),{authenticate:async()=>owner,services:()=>({repository:{prepare:async()=>({state:'new',reply:prepared}),finish},sender:{send}})});
    expect(await response.json()).toEqual({state:'needs_review'});expect(send).toHaveBeenCalledOnce();
  });
});

import {InboxRepository,waitingLabel} from '../src/modules/admin/inbox';
import type {SupabaseClient} from '@supabase/supabase-js';
describe('inbox query scope',()=>{
  it('filters and orders waiting cases in the database before limiting results',async()=>{
    const q={select:vi.fn(),eq:vi.fn(),in:vi.fn(),order:vi.fn(),limit:vi.fn().mockResolvedValue({data:[],error:null})};
    for(const fn of [q.select,q.eq,q.in,q.order])fn.mockReturnValue(q);
    const db={from:vi.fn(()=>q)} as unknown as SupabaseClient;
    await new InboxRepository(db).conversations(tenant,'attention',100);
    expect(q.eq).toHaveBeenCalledWith('tenant_id',tenant);expect(q.in).toHaveBeenCalledWith('attention_state',['waiting','in_progress']);
    expect(q.order).toHaveBeenCalledWith('attention_since',{ascending:true});expect(q.limit).toHaveBeenCalledWith(100);
    await new InboxRepository(db).conversations(tenant,'complaints');expect(q.eq).toHaveBeenCalledWith('is_complaint',true);
    await new InboxRepository(db).conversations(tenant,'resolved');expect(q.eq).toHaveBeenCalledWith('attention_state','resolved');
  });
  it('counts all matching tenant rows without fetching message bodies or limiting the count',async()=>{
    const q={select:vi.fn(),eq:vi.fn(),in:vi.fn(),then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({count:63,error:null}).then(resolve)};
    for(const fn of [q.select,q.eq,q.in])fn.mockReturnValue(q);
    const db={from:()=>q} as unknown as SupabaseClient;
    expect(await new InboxRepository(db).counts(tenant)).toEqual({all:63,attention:63,complaints:63,resolved:63});
    expect(q.select).toHaveBeenCalledWith('id',{count:'exact',head:true});expect(q.eq).toHaveBeenCalledWith('tenant_id',tenant);
  });
  it('keeps long waiting times visible and never shows negative waiting times',()=>{
    expect(waitingLabel('2026-09-16T10:00:00Z',Date.parse('2026-09-18T11:00:00Z'))).toBe('Waiting 2d 1h');
    expect(waitingLabel('2026-09-16T10:00:00Z',Date.parse('2026-09-16T09:59:00Z'))).toBe('Waiting just now');
  });
});
