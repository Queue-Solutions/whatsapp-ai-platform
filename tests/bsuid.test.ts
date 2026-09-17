import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {parseWebhook} from '../src/modules/whatsapp/parser';
import {receiveWebhook} from '../src/modules/whatsapp/webhook';
import {MetaMessageSender} from '../src/modules/whatsapp/sender';
import {readEnvironment,type Environment} from '../src/config/env';
import type {MessagingRepository,PreparedReply} from '../src/modules/messaging/types';
import {InboxRepository} from '../src/modules/admin/inbox';
import type {SupabaseClient} from '@supabase/supabase-js';
const phone='201000000001',bsuid='EG.Abc123',channel='9001',secret='s'.repeat(32);
const env:Environment={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:secret,META_APP_SECRET:secret,WHATSAPP_VERIFY_TOKEN:secret,META_GRAPH_API_VERSION:'v24.0',WHATSAPP_ACCESS_TOKEN:secret,WHATSAPP_TEST_PHONE_NUMBER_ID:channel,WHATSAPP_TEST_RECIPIENTS:[phone],WHATSAPP_MODE:'test',CRON_SECRET:secret};
const message=(overrides:Record<string,unknown>={})=>({id:'inbound',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Fictional question'},from_user_id:bsuid,...overrides});
const payload=(messages:unknown[],contacts:unknown[]=[])=>({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:channel},contacts,messages}}]}]});
const request=(body:unknown)=>{const raw=JSON.stringify(body);return new Request('https://example.test/webhook',{method:'POST',body:raw,headers:{'x-hub-signature-256':`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`}});};
describe('Meta BSUID protocol',()=>{
 it('accepts hidden-number users and phone-plus-BSUID users with correctly matched profiles',()=>{
  const contact={user_id:bsuid,profile:{name:'Maya',username:'maya.test'}};
  expect(parseWebhook(payload([message()],[contact])).messages[0]).toMatchObject({from:bsuid,userId:bsuid,displayName:'Maya',username:'maya.test'});
  expect(parseWebhook(payload([message({from:phone})],[{...contact,wa_id:phone}])).messages[0]).toMatchObject({from:phone,userId:bsuid});
  expect(()=>parseWebhook(payload([message({from_user_id:undefined})]))).toThrow('Missing sender');
  expect(()=>parseWebhook(payload([message({from:phone})],[{...contact,wa_id:'201000000002'}]))).toThrow('Conflicting');
  expect(()=>parseWebhook(payload([message({from_user_id:'@maya'})]))).toThrow();
 });
 it('separates BSUID change system events from messages and tolerates hidden-number status events',()=>{
  const result=parseWebhook(payload([message({type:'system',system:{type:'user_changed_user_id',user_id:'EG.New456',previous_user_id:bsuid}})]));
  expect(result.messages).toEqual([]);expect(result.identityChanges[0]).toMatchObject({previousIdentifier:bsuid,newUserId:'EG.New456'});
  const data={object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:channel},contacts:[{user_id:bsuid,profile:{username:'maya'}}],statuses:[{id:'outbound',timestamp:'1700000000',status:'read',recipient_user_id:bsuid}]}}]}]};
  expect(parseWebhook(data)).toMatchObject({messages:[],identityChanges:[],statuses:[{providerMessageId:'outbound',status:'read'}]});
 });
 it('sends BSUIDs in recipient, phones in to, and requires an exact allowlisted identity or verified alias',async()=>{
  const fetcher=vi.fn().mockImplementation(async()=>Response.json({messages:[{id:'outbound'}]}));
  const sender=new MetaMessageSender(env,fetcher),reply={outbound_id:'out',phone_number_id:channel,recipient:bsuid,body:'Fictional reply'};
  await expect(sender.send(reply)).rejects.toMatchObject({code:'test_guard_rejected'});expect(fetcher).not.toHaveBeenCalled();
  await sender.send({...reply,recipient_aliases:[phone]});
  const sent=JSON.parse(fetcher.mock.calls[0][1].body);expect(sent.recipient).toBe(bsuid);expect(sent).not.toHaveProperty('to');
  await sender.send({...reply,recipient:phone});expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({to:phone});
  await expect(sender.send({...reply,recipient:'@maya',recipient_aliases:[phone]})).rejects.toThrow();
  const configured=readEnvironment({...env,WHATSAPP_TEST_RECIPIENTS:phone+','+bsuid});expect(configured.WHATSAPP_TEST_RECIPIENTS).toEqual([phone,bsuid]);
  await expect(new MetaMessageSender(configured,vi.fn().mockRejectedValue(new Error('timeout'))).send(reply)).rejects.toMatchObject({ambiguous:true,code:'network_outcome_unknown'});
 });
 it('never resolves or ingests unsigned BSUID webhooks, and fails closed for unapproved identities',async()=>{
  const repository={ingest:vi.fn(),isAllowedIdentity:vi.fn().mockResolvedValue(false)} as unknown as MessagingRepository;
  const options={appSecret:secret,phoneNumberId:channel,recipients:[phone],repository};
  expect((await receiveWebhook(new Request('https://example.test',{method:'POST',body:JSON.stringify(payload([message()]))}),options)).status).toBe(403);
  expect(repository.isAllowedIdentity).not.toHaveBeenCalled();
  expect((await receiveWebhook(request(payload([message()])),options)).status).toBe(200);expect(repository.ingest).not.toHaveBeenCalled();
  expect((await receiveWebhook(request(payload([message()])),{...options,recipients:[bsuid]})).status).toBe(200);expect(repository.ingest).toHaveBeenCalledOnce();
 });
 it('shows actual phone numbers separately and never turns a BSUID into a fake phone number',async()=>{
  const data:Record<string,unknown[]>={conversations:[{id:'1',customer_id:'1'},{id:'2',customer_id:'2'}],customers:[{id:'1',display_name:'Maya',whatsapp_id:phone},{id:'2',whatsapp_id:null,whatsapp_username:'maya.test'}]};
  const db={from:(table:string)=>{const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,limit:()=>q,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:data[table]}).then(resolve)};return q;}} as unknown as SupabaseClient;
  expect(await new InboxRepository(db).conversations('tenant')).toMatchObject([{name:'Maya',phone},{name:'@maya.test',phone:null,username:'maya.test'}]);
 });
});
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('BSUID persistence, continuity and permissions',()=>{
 let db:PGlite;
 async function rows<T=Record<string,unknown>>(sql:string,args:unknown[]=[]){return(await db.query<T>(sql,args)).rows;}
 async function ingest(id:string,from:string,userId:string|null=null,ch=channel){return(await rows<{v:string}>("select public.ingest_whatsapp_identity_message($1,$2,$3,'Maya',now(),'text','Fictional message',$4,'maya.test') as v",[ch,id,from,userId]))[0].v;}
 async function allowed(id:string,list:string[],ch=channel){return(await rows<{v:boolean}>('select public.is_allowed_whatsapp_identity($1,$2,$3) as v',[ch,id,list]))[0].v;}
 async function claim(){return(await rows<{id:string;lease_token:string}>("select * from public.claim_message_job('9001')"))[0];}
 async function prepare(job:Awaited<ReturnType<typeof claim>>){return(await rows<{v:PreparedReply|null}>("select public.prepare_followup_reply($1,$2,'Fictional greeting','clarify','[]','social_greeting') as v",[job.id,job.lease_token]))[0].v;}
 async function change(previous=bsuid,next='EG.New456',newPhone:string|null=null,id='change',occurred=new Date().toISOString()){
  await db.query('select public.update_whatsapp_identity($1,$2,$3,$4,$5,$6)',[channel,id,previous,newPhone,next,occurred]);
 }
 beforeAll(async()=>{
  db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await db.exec('reset role;truncate public.tenants,auth.users cascade;');await db.query("insert into public.tenants(id,name,slug) values($1,'Demo','demo'),($2,'Other','other')",[tenant,other]);await db.query("insert into public.whatsapp_channels(tenant_id,phone_number_id) values($1,'9001'),($2,'9002')",[tenant,other]);await db.query('insert into auth.users values($1)',[owner]);await db.query("insert into public.tenant_memberships values($1,$2,'owner')",[tenant,owner]);});
 it('retains one customer and conversation through phone-only, paired, hidden-number and duplicate events',async()=>{
  await db.query("select public.ingest_whatsapp_message('9001','legacy',$1,'Maya',now(),'text','Fictional legacy message')",[phone]);
  const [before]=await rows('select id,customer_id from public.conversations');
  await ingest('paired',phone,bsuid);const hidden=await ingest('hidden',bsuid,bsuid);expect(await ingest('hidden',bsuid,bsuid)).toBe(hidden);
  expect(await rows('select id,customer_id from public.conversations')).toEqual([before]);expect(await rows('select id from public.customers')).toHaveLength(1);
  expect(await rows('select id from public.messages')).toHaveLength(3);expect(await rows('select id from public.message_jobs')).toHaveLength(3);
  expect(await allowed(bsuid,[phone])).toBe(true);expect(await allowed(bsuid,[])).toBe(false);expect(await allowed(bsuid,[phone],'9002')).toBe(false);
  const job=await claim(),reply=await prepare(job);expect(reply).toMatchObject({recipient:bsuid,recipient_aliases:expect.arrayContaining([phone,bsuid])});
  await db.query("select public.fail_message_job($1,$2,'needs_review','network_outcome_unknown')",[job.id,job.lease_token]);await expect(prepare(job)).rejects.toThrow('lease');
 });
 it('creates hidden-number contacts without a fake phone, isolates channels/tenants and denies browser mapping access',async()=>{
  await ingest('hidden',bsuid,bsuid);await ingest('other',bsuid,bsuid,'9002');
  expect(await rows('select whatsapp_id from public.customers')).toEqual([{whatsapp_id:null},{whatsapp_id:null}]);
  expect(await allowed(bsuid,[phone])).toBe(false);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
  expect(await rows('select id from public.customers')).toHaveLength(1);
  await expect(db.exec('select * from public.whatsapp_identities')).rejects.toThrow();await expect(allowed(bsuid,[phone])).rejects.toThrow();await expect(ingest('attack',phone,bsuid)).rejects.toThrow();
 });
 it('refuses conflicting identity merges and retires changed IDs without opening a service window or transferring approval',async()=>{
  await ingest('paired',phone,bsuid);const [before]=await rows('select id,customer_id,last_inbound_at from public.conversations');const job=await claim();
  await change();await change();
  expect(await rows('select id,customer_id,last_inbound_at from public.conversations')).toEqual([before]);
  expect(await rows('select provider_message_id from public.whatsapp_identity_events')).toHaveLength(1);
  expect(await rows('select id from public.message_jobs')).toHaveLength(1);expect(await prepare(job)).toBeNull();
  expect(await allowed('EG.New456',[phone])).toBe(false);expect(await allowed('EG.New456',[bsuid])).toBe(false);expect(await allowed('EG.New456',['EG.New456'])).toBe(true);
  expect((await rows('select whatsapp_id from public.customers'))[0].whatsapp_id).toBeNull();
  await expect(ingest('retired',phone,bsuid)).rejects.toThrow('Retired');
  await ingest('other-person','201000000002','EG.Other789');
  await expect(ingest('conflict','201000000002','EG.New456')).rejects.toThrow('Conflicting');
  await expect(change('EG.New456','EG.Other789',null,'conflict-change')).rejects.toThrow('Conflicting');
 });
 it('keeps signed webhook batches ordered and links approved hidden-number replies without duplicates',async()=>{
  const repository={
    ingest:async(m:{providerMessageId:string;from:string;userId?:string})=>{await ingest(m.providerMessageId,m.from,m.userId??null);},
    isAllowedIdentity:allowed,
    updateIdentity:async(c:{previousIdentifier:string;newUserId:string;newPhone?:string;providerMessageId:string;occurredAt:string})=>{await change(c.previousIdentifier,c.newUserId,c.newPhone??null,c.providerMessageId,c.occurredAt);},
  } as unknown as MessagingRepository;
  const options={appSecret:secret,phoneNumberId:channel,recipients:[phone,'EG.New456'],repository};
  const batch=payload([message({id:'paired',from:phone}),message({id:'hidden'}),message({id:'change',type:'system',system:{type:'user_changed_user_id',previous_user_id:bsuid,user_id:'EG.New456'}}),message({id:'after-change',from_user_id:'EG.New456'})]);
  expect((await receiveWebhook(request(batch),options)).status).toBe(200);
  expect((await receiveWebhook(request(batch),options)).status).toBe(200);
  expect(await rows('select id from public.customers')).toHaveLength(1);expect(await rows('select id from public.conversations')).toHaveLength(1);
  expect(await rows('select id from public.messages')).toHaveLength(3);expect(await rows('select provider_message_id from public.whatsapp_identity_events')).toHaveLength(1);
 });
 it('handles disclosed number changes without mistaking a callback number for a verified identity',async()=>{
  await ingest('paired',phone,bsuid);
  await db.exec("update public.conversations set followup_phone='201099999999'");
  expect(await allowed(bsuid,['201099999999'])).toBe(false);
  await change(bsuid,'EG.New456','201000000003','number-change');
  expect((await rows('select whatsapp_id from public.customers'))[0].whatsapp_id).toBe('201000000003');
  expect((await rows('select reply_recipient from public.conversations'))[0].reply_recipient).toBe('201000000003');
  expect(await allowed('EG.New456',[phone])).toBe(false);
  expect(await allowed('EG.New456',['201000000003'])).toBe(true);
  await change('EG.New456','EG.Older','201000000004','stale','2020-01-01T00:00:00Z');
  expect((await rows('select reply_recipient from public.conversations'))[0].reply_recipient).toBe('201000000003');
 });
 it('supports manual replies to a BSUID through a proven allowlisted phone while retaining actor/channel guards',async()=>{
  await ingest('paired',phone,bsuid);await ingest('hidden',bsuid,bsuid);
  const [c]=await rows<{id:string}>('select id from public.conversations');await db.query("update public.conversations set automation_mode='human' where id=$1",[c.id]);
  const args=[owner,c.id,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','Fictional personal reply',channel,[phone]];
  const [result]=await rows<{v:{state:string;reply:PreparedReply}}>('select public.prepare_manual_reply($1,$2,$3,$4,$5,$6) as v',args);
  expect(result.v).toMatchObject({state:'new',reply:{recipient:bsuid,recipient_aliases:expect.arrayContaining([phone])}});
  expect((await rows<{v:{state:string}}>('select public.prepare_manual_reply($1,$2,$3,$4,$5,$6) as v',args))[0].v.state).toBe('sending');
  await expect(db.query('select public.prepare_manual_reply($1,$2,$3,$4,$5,$6)',[...args.slice(0,2),'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',args[3],'9002',[phone]])).rejects.toThrow('Test guard');
 });
});
