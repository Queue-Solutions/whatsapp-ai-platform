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
    for(const file of ['202609120001_foundation.sql','202609120002_bounded_ai.sql','202609130001_inbox.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
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
