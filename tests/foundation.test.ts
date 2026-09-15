import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { parseWebhook } from '../src/modules/whatsapp/parser';
import { receiveWebhook, verifyWebhook } from '../src/modules/whatsapp/webhook';
import { validSignature } from '../src/modules/whatsapp/security';
import { MetaMessageSender, SendError } from '../src/modules/whatsapp/sender';
import { processIncomingMessage } from '../src/modules/messaging/process-incoming-message';
import { echoStrategy } from '../src/modules/messaging/echo-strategy';
import { readEnvironment } from '../src/config/env';
import type { Environment } from '../src/config/env';
import type { MessagingRepository, MessageJob, PreparedReply, IncomingMessage } from '../src/modules/messaging/types';

const tenant='11111111-1111-4111-8111-111111111111';
const otherTenant='22222222-2222-4222-8222-222222222222';
const user='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const phone='9001', recipient='201000000001', secret='a'.repeat(32);
const env:Environment={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'s'.repeat(32),META_APP_SECRET:secret,
  WHATSAPP_VERIFY_TOKEN:secret,META_GRAPH_API_VERSION:'v24.0',WHATSAPP_ACCESS_TOKEN:'t'.repeat(32),
  WHATSAPP_TEST_PHONE_NUMBER_ID:phone,WHATSAPP_TEST_RECIPIENTS:[recipient],WHATSAPP_MODE:'test',CRON_SECRET:secret};
const incoming=(id='wamid.inbound'):IncomingMessage=>({phoneNumberId:phone,providerMessageId:id,from:recipient,
  occurredAt:new Date().toISOString(),type:'text',text:'أهلاً hello'});
function fixture(){return {object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:phone},
  messages:[{id:'wamid.inbound',from:recipient,type:'text',text:{body:'أهلاً hello'},timestamp:String(Math.floor(Date.now()/1000))}]}}]}]};}
function request(body=JSON.stringify(fixture()),signature?:string){return new Request('https://example.test/api/webhooks/whatsapp',{
  method:'POST',body,headers:{'x-hub-signature-256':signature??`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`}});}

describe('webhook boundary and sender',()=>{
  it('returns the verification challenge only for the matching token and mode',()=>{
    expect(verifyWebhook(new Request(`https://x.test/?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=1234`),secret).status).toBe(200);
    expect(verifyWebhook(new Request('https://x.test/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234'),secret).status).toBe(403);
  });
  it('verifies the exact raw body including Arabic text',()=>{
    const raw=Buffer.from(JSON.stringify(fixture()));
    const sig=`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`;
    expect(validSignature(raw,sig,secret)).toBe(true);
    expect(validSignature(Buffer.concat([raw,Buffer.from(' ')]),sig,secret)).toBe(false);
    expect(validSignature(raw,'sha256=x',secret)).toBe(false);
  });
  it('parses batched messages and delivery statuses without treating statuses as inbound',()=>{
    const f=fixture();f.entry.push(f.entry[0]);
    expect(parseWebhook(f).messages).toHaveLength(2);
    expect(parseWebhook({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:phone},
      statuses:[{id:'wamid.sent',status:'read',timestamp:'1700000000'}]}}]}]})).toMatchObject({messages:[],statuses:[{status:'read'}]});
  });
  it('rejects text events without a body',()=>{
    const f=fixture();Reflect.deleteProperty(f.entry[0].changes[0].value.messages[0],'text');
    expect(()=>parseWebhook(f)).toThrow();
  });
  it('never persists an unsigned request',async()=>{
    const ingest=vi.fn();const repository={ingest} as unknown as MessagingRepository;
    expect((await receiveWebhook(request(undefined,'bad'),{appSecret:secret,phoneNumberId:phone,recipients:[recipient],repository})).status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });
  it('rejects oversized requests before ingestion',async()=>{
    const response=await receiveWebhook(request('x'.repeat(1024*1024+1)),{appSecret:secret,phoneNumberId:phone,recipients:[recipient],repository:{} as MessagingRepository});
    expect(response.status).toBe(413);
  });
  it('acknowledges but does not ingest other numbers or unapproved recipients',async()=>{
    const repository={ingest:vi.fn()} as unknown as MessagingRepository;
    const options={appSecret:secret,phoneNumberId:'9999',recipients:[recipient],repository};
    expect((await receiveWebhook(request(),options)).status).toBe(200);
    expect((await receiveWebhook(request(),{...options,phoneNumberId:phone,recipients:[]})).status).toBe(200);
    expect(repository.ingest).not.toHaveBeenCalled();
  });
  it('requests redelivery when persistence fails',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const repository={ingest:vi.fn().mockRejectedValue(new Error())} as unknown as MessagingRepository;
    expect((await receiveWebhook(request(),{appSecret:secret,phoneNumberId:phone,recipients:[recipient],repository})).status).toBe(503);
    log.mockRestore();
  });
  it('blocks sends outside the test channel and recipient list',async()=>{
    const fetcher=vi.fn();const sender=new MetaMessageSender(env,fetcher);
    await expect(sender.send({outbound_id:'x',phone_number_id:'other',recipient,body:'x'})).rejects.toMatchObject({code:'test_guard_rejected'});
    await expect(sender.send({outbound_id:'x',phone_number_id:phone,recipient:'201999999999',body:'x'})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('constructs a Cloud API text request and returns the provider ID',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({messages:[{id:'wamid.out'}]}));
    expect(await new MetaMessageSender(env,fetcher).send({outbound_id:'x',phone_number_id:phone,recipient,body:'أهلاً'})).toBe('wamid.out');
    expect(fetcher.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/9001/messages');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({to:recipient,messaging_product:'whatsapp',text:{body:'أهلاً'}});
  });
  it('distinguishes rejected and ambiguous sends without exposing Meta response bodies',async()=>{
    const reply={outbound_id:'x',phone_number_id:phone,recipient,body:'x'};
    await expect(new MetaMessageSender(env,vi.fn().mockResolvedValue(new Response('private error',{status:401}))).send(reply)).rejects.toMatchObject({ambiguous:false,code:'meta_http_401'});
    await expect(new MetaMessageSender(env,vi.fn().mockResolvedValue(Response.json({error:{code:200,error_subcode:123,message:'private content'}},{status:403}))).send(reply)).rejects.toMatchObject({ambiguous:false,code:'meta_http_403_code_200_subcode_123'});
    await expect(new MetaMessageSender(env,vi.fn().mockRejectedValue(new Error('timeout'))).send(reply)).rejects.toMatchObject({ambiguous:true});
    await expect(new MetaMessageSender(env,vi.fn().mockResolvedValue(Response.json({}))).send(reply)).rejects.toMatchObject({ambiguous:true});
  });
  it('requires test mode and a nonempty recipient allowlist',()=>{
    const source={...env,WHATSAPP_TEST_RECIPIENTS:recipient};
    expect(readEnvironment(source).WHATSAPP_MODE).toBe('test');
    expect(()=>readEnvironment({...source,WHATSAPP_MODE:'live'})).toThrow();
    expect(()=>readEnvironment({...source,WHATSAPP_TEST_RECIPIENTS:''})).toThrow();
  });
});

describe('PostgreSQL migration and complete message flow',()=>{
  let db:PGlite;
  async function scalar<T>(sql:string,args:unknown[]=[]):Promise<T>{return (await db.query<{v:T}>(sql,args)).rows[0].v;}
  async function rpc<T>(name:string,args:unknown[]=[]):Promise<T>{return scalar<T>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as v`,args);}
  const repo:MessagingRepository={
    async ingest(m){await rpc('ingest_whatsapp_message',[m.phoneNumberId,m.providerMessageId,m.from,m.displayName??null,m.occurredAt,m.type,m.text]);},
    async recordStatus(s){await rpc('record_whatsapp_status',[s.phoneNumberId,s.providerMessageId,s.status,s.occurredAt,s.errorCode??null]);},
    async claim(){return (await db.query<MessageJob>('select * from public.claim_message_job($1)',[phone])).rows[0]??null;},
    async context(j){const m=(await db.query<{conversation_id:string;body:string;message_type:string}>('select * from public.messages where id=$1 and tenant_id=$2',[j.inbound_message_id,j.tenant_id])).rows[0];
      return {tenantId:j.tenant_id,conversationId:m.conversation_id,text:m.body,type:m.message_type};},
    prepare(j,text){return rpc<PreparedReply|null>('prepare_message_reply',[j.id,j.lease_token,text]);},
    async complete(j,id){await rpc('complete_message_job',[j.id,j.lease_token,id]);},
    async fail(j,state,code){await rpc('fail_message_job',[j.id,j.lease_token,state,code]);},
  };
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    await db.exec(await readFile(new URL('../supabase/migrations/202609120001_foundation.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202609150001_faq_deletion.sql',import.meta.url),'utf8'));
  });
  afterAll(async()=>{await db?.close();});
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.tenants,auth.users cascade;');
    await db.query('insert into public.tenants(id,name,slug) values($1,$2,$3),($4,$5,$6)',[tenant,'Development','dev',otherTenant,'Other','other']);
    await db.query('insert into public.whatsapp_channels(tenant_id,phone_number_id) values($1,$2),($3,$4)',[tenant,phone,otherTenant,'9002']);
  });
  it('runs a signed webhook → PostgreSQL → processor → fake Meta echo exactly once on redelivery',async()=>{
    const opts={appSecret:secret,phoneNumberId:phone,recipients:[recipient],repository:repo};
    expect((await receiveWebhook(request(),opts)).status).toBe(200);
    expect((await receiveWebhook(request(),opts)).status).toBe(200);
    const job=await repo.claim();expect(job).not.toBeNull();
    const send=vi.fn().mockResolvedValue('wamid.out');
    expect(await processIncomingMessage(job!,{repository:repo,sender:{send},strategy:echoStrategy})).toBe('sent');
    expect(send).toHaveBeenCalledOnce();expect(send.mock.calls[0][0].body).toBe('Echo: أهلاً hello');
    expect(await repo.claim()).toBeNull();
    expect(await scalar('select count(*)::int as v from public.customers')).toBe(1);
    expect(await scalar('select count(*)::int as v from public.conversations')).toBe(1);
    expect(await scalar('select count(*)::int as v from public.messages')).toBe(2);
    expect(await scalar('select state as v from public.message_jobs')).toBe('completed');
  });
  it('does not auto-reply after a human takeover',async()=>{
    await repo.ingest(incoming());const job=await repo.claim();
    await db.exec("update public.conversations set automation_mode='human'");
    const send=vi.fn();expect(await processIncomingMessage(job!,{repository:repo,sender:{send},strategy:echoStrategy})).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });
  it('skips expired service windows and rejects future timestamps',async()=>{
    await repo.ingest({...incoming(),occurredAt:new Date(Date.now()-25*3600000).toISOString()});
    expect(await repo.prepare((await repo.claim())!,'old')).toBeNull();
    await expect(repo.ingest({...incoming('future'),occurredAt:new Date(Date.now()+3600000).toISOString()})).rejects.toThrow();
  });
  it('serializes jobs within a conversation',async()=>{
    await repo.ingest(incoming('one'));await repo.ingest(incoming('two'));
    const first=await repo.claim();expect(first).not.toBeNull();expect(await repo.claim()).toBeNull();
    await repo.prepare(first!,'one');await repo.complete(first!,'out.one');expect(await repo.claim()).not.toBeNull();
  });
  it('recovers stale processing leases and rejects the old lease',async()=>{
    await repo.ingest(incoming());const old=await repo.claim();
    await db.exec("update public.message_jobs set leased_until=now()-interval '1 minute'");
    const replacement=await repo.claim();expect(replacement!.lease_token).not.toBe(old!.lease_token);
    await expect(repo.prepare(old!,'stale')).rejects.toThrow();
    expect(await repo.prepare(replacement!,'fresh')).not.toBeNull();
  });
  it('never automatically resends an ambiguous network outcome',async()=>{
    await repo.ingest(incoming());const send=vi.fn().mockRejectedValue(new SendError(true,'network_outcome_unknown'));
    expect(await processIncomingMessage((await repo.claim())!,{repository:repo,sender:{send},strategy:echoStrategy})).toBe('needs_review');
    await repo.ingest(incoming());expect(await repo.claim()).toBeNull();expect(send).toHaveBeenCalledOnce();
  });
  it('marks expired sending leases for review instead of retry',async()=>{
    await repo.ingest(incoming());await repo.prepare((await repo.claim())!,'hello');
    await db.exec("update public.message_jobs set leased_until=now()-interval '1 minute'");
    expect(await repo.claim()).toBeNull();
    expect(await scalar('select state as v from public.message_jobs')).toBe('needs_review');
    expect(await scalar("select delivery_status as v from public.messages where direction='outbound'")).toBe('needs_review');
  });
  it('preserves delivery receipts arriving before send completion and out of order',async()=>{
    await repo.ingest(incoming());const j=(await repo.claim())!;await repo.prepare(j,'hello');
    const status={phoneNumberId:phone,providerMessageId:'wamid.out',status:'read' as const,occurredAt:new Date().toISOString()};
    await repo.recordStatus(status);await repo.recordStatus(status);await repo.complete(j,'wamid.out');
    await repo.recordStatus({...status,status:'sent'});
    expect(await scalar("select delivery_status as v from public.messages where direction='outbound'")).toBe('read');
    expect(await scalar('select count(*)::int as v from public.message_status_events')).toBe(2);
  });
  it('rejects unknown/live channel routing and rolls back invalid ingestion',async()=>{
    await expect(repo.ingest({...incoming(),phoneNumberId:'9999'})).rejects.toThrow();
    await expect(db.query("insert into public.whatsapp_channels(tenant_id,phone_number_id,mode) values($1,'123','live')",[tenant])).rejects.toThrow();
    await expect(repo.ingest({...incoming(),text:null,type:null as unknown as string})).rejects.toThrow();
    expect(await scalar('select count(*)::int as v from public.customers')).toBe(0);
  });
  it('enforces composite tenant foreign keys',async()=>{
    await repo.ingest(incoming());
    await expect(db.query('update public.conversations set tenant_id=$1',[otherTenant])).rejects.toThrow();
  });
  it('denies anonymous table/RPC access and isolates authenticated tenant reads and edits',async()=>{
    await repo.ingest(incoming());await repo.ingest({...incoming('other'),phoneNumberId:'9002'});
    await db.query('insert into auth.users(id) values($1)',[user]);
    await db.query("insert into public.tenant_memberships values($1,$2,'admin')",[tenant,user]);
    await db.exec('set role anon');
    await expect(db.query('select * from public.customers')).rejects.toThrow();
    await expect(repo.claim()).rejects.toThrow();
    await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
    expect(await scalar('select count(*)::int as v from public.customers')).toBe(1);
    await db.query("insert into public.faqs(tenant_id,question,answer) values($1,'Hours?','9–5')",[tenant]);
    await expect(db.query("insert into public.faqs(tenant_id,question,answer) values($1,'Hours?','9–5')",[otherTenant])).rejects.toThrow();
    await expect(db.query('update public.faqs set tenant_id=$1',[otherTenant])).rejects.toThrow();
    await expect(db.exec("update public.conversations set automation_mode='human'")).rejects.toThrow();
    await expect(repo.claim()).rejects.toThrow();await db.exec('reset role');
  });
  it('persists knowledge drafts and approvals, isolating owner edits from viewers and other tenants', async () => {
    await db.query('insert into auth.users(id) values($1)', [user]);
    await db.query("insert into public.tenant_memberships values($1,$2,'owner')", [tenant,user]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec('set role authenticated');
    await db.query("insert into public.faqs(tenant_id,question,answer) values($1,'What are the payment options?','')", [tenant]);
    expect(await scalar('select is_published as v from public.faqs')).toBe(false);
    await db.query("insert into public.business_facts(tenant_id,category,fact_key,value) values($1,'branch','branch:test',$2)",
      [tenant,JSON.stringify({name:'',address:'',hours:'',exceptions:'',phone:'',mapsUrl:''})]);
    expect(await scalar("select value->>'mapsUrl' as v from public.business_facts")).toBe('');
    await db.exec("update public.faqs set answer='إجابة معتمدة للاختبار',is_published=true");
    expect(await scalar('select answer as v from public.faqs')).toBe('إجابة معتمدة للاختبار');
    await expect(db.query("insert into public.business_facts(tenant_id,category,fact_key,value) values($1,'branch','branch:other','{}')",[otherTenant])).rejects.toThrow();
    await db.exec('reset role');
    await db.query("update public.tenant_memberships set role='viewer' where user_id=$1",[user]);
    await db.exec('set role authenticated');
    expect(await scalar('select count(*)::int as v from public.faqs')).toBe(1);
    expect((await db.exec("update public.faqs set answer='unauthorized' returning id"))[0].rows).toHaveLength(0);
    expect((await db.exec("delete from public.business_facts returning id"))[0].rows).toHaveLength(0);
    await expect(db.query("insert into public.faqs(tenant_id,question,answer) values($1,'Unauthorized?','No')",[tenant])).rejects.toThrow();
    await db.exec('reset role');
    await db.query("update public.tenant_memberships set tenant_id=$1 where user_id=$2",[otherTenant,user]);
    await db.exec('set role authenticated');
    expect(await scalar('select count(*)::int as v from public.faqs')).toBe(0);
    expect(await scalar('select count(*)::int as v from public.business_facts')).toBe(0);
    await db.exec('reset role');
  });
  it('isolates FAQ deletion markers and branch deletes, and prevents publishing deleted FAQs', async () => {
    await db.query('insert into auth.users(id) values($1)', [user]);
    await db.query("insert into public.tenant_memberships values($1,$2,'admin')", [tenant,user]);
    for (const tenantId of [tenant, otherTenant]) {
      await db.query("insert into public.faqs(tenant_id,question,answer) values($1,'Question','Answer')", [tenantId]);
      await db.query("insert into public.business_facts(tenant_id,category,fact_key,value) values($1,'branch','branch:delete','{}')", [tenantId]);
    }
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec('set role authenticated');
    expect((await db.exec("update public.faqs set deleted_at=now(),answer='',question='',is_published=false returning id"))[0].rows).toHaveLength(1);
    await expect(db.exec('update public.faqs set is_published=true')).rejects.toThrow();
    expect((await db.exec('delete from public.business_facts returning id'))[0].rows).toHaveLength(1);
    await db.exec('reset role');
    expect((await db.query('select id from public.faqs where tenant_id=$1 and deleted_at is null', [otherTenant])).rows).toHaveLength(1);
    expect((await db.query('select id from public.business_facts where tenant_id=$1', [otherTenant])).rows).toHaveLength(1);
    await db.query("update public.tenant_memberships set role='viewer' where user_id=$1", [user]);
    await db.exec('set role authenticated');
    expect((await db.exec('update public.faqs set deleted_at=now() returning id'))[0].rows).toHaveLength(0);
    await db.exec('reset role');
  });
  it('permits service-role RPCs with explicit grants',async()=>{
    await db.exec('set role service_role');await repo.ingest(incoming());expect(await repo.claim()).not.toBeNull();await db.exec('reset role');
  });
});
