import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {readPilotConnection,readPilotVerifyToken,connectionForChannel,type WhatsAppConnection} from '../src/config/whatsapp-connections';
import {MetaMessageSender,ConfiguredMetaMessageSender} from '../src/modules/whatsapp/sender';
import {SupabaseMessagingRepository} from '../src/modules/messaging/supabase-repository';
import {receiveWebhook} from '../src/modules/whatsapp/webhook';
import {availabilityChannel} from '../src/modules/admin/inbox';
import type {MessagingRepository,PreparedReply} from '../src/modules/messaging/types';

const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',viewer='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const phone='201000000001',second='201000000002',secret='synthetic-secret-value-for-unit-tests';
const pilot:WhatsAppConnection={mode:'pilot',tenantId:tenant,appId:'123',phoneNumberId:'9100',appSecret:secret,verifyToken:secret,accessToken:secret,graphVersion:'v24.0',recipients:[phone],sendEnabled:true};
const source={WHATSAPP_PILOT_ENABLED:'true',WHATSAPP_PILOT_TENANT_ID:tenant,WHATSAPP_PILOT_APP_ID:'123',WHATSAPP_PILOT_PHONE_NUMBER_ID:'9100',WHATSAPP_PILOT_APP_SECRET:secret,WHATSAPP_PILOT_VERIFY_TOKEN:secret,WHATSAPP_PILOT_ACCESS_TOKEN:secret,WHATSAPP_PILOT_GRAPH_API_VERSION:'v24.0',WHATSAPP_PILOT_RECIPIENTS:phone};

describe('isolated pilot transport',()=>{
 it('requires explicit configuration and defaults sends off without leaking values in errors',()=>{
  expect(readPilotConnection({})).toBeNull();
  expect(readPilotVerifyToken(source)).toBe(secret);
  expect(readPilotVerifyToken({...source,WHATSAPP_PILOT_ENABLED:'false'})).toBe(secret);
  expect(()=>readPilotVerifyToken({WHATSAPP_PILOT_VERIFY_TOKEN:'short'})).toThrow('WHATSAPP_PILOT_VERIFY_TOKEN');
  expect(readPilotConnection(source)).toMatchObject({sendEnabled:false,mode:'pilot',tenantId:tenant});
  expect(()=>readPilotConnection({...source,WHATSAPP_TEST_PHONE_NUMBER_ID:'9100'})).toThrow('different');
  expect(()=>readPilotConnection({...source,WHATSAPP_PILOT_TENANT_ID:'bad-'+secret})).toThrow('WHATSAPP_PILOT_TENANT_ID');
  try{readPilotConnection({...source,WHATSAPP_PILOT_APP_SECRET:'private'});}catch(e){expect(String(e)).not.toContain('private');}
  expect(connectionForChannel([pilot],{tenant_id:other,phone_number_id:'9100',mode:'pilot'})).toBeNull();
  expect(connectionForChannel([pilot],{tenant_id:tenant,phone_number_id:'9100',mode:'test'})).toBeNull();
 });
 it('never sends through a disabled, mismatched or unapproved channel and retains unknown outcomes',async()=>{
  const fetcher=vi.fn().mockResolvedValue(Response.json({messages:[{id:'synthetic-outbound'}]}));
  const reply:PreparedReply={tenant_id:tenant,outbound_id:'out',phone_number_id:'9100',recipient:phone,body:'Synthetic reply'};
  await expect(new MetaMessageSender({...pilot,sendEnabled:false},fetcher).send(reply)).rejects.toMatchObject({ambiguous:false,code:'pilot_guard_rejected'});
  for(const invalid of [{...reply,tenant_id:other},{...reply,tenant_id:undefined},{...reply,recipient:second},{...reply,phone_number_id:'9001'}]){
   await expect(new MetaMessageSender(pilot,fetcher).send(invalid)).rejects.toMatchObject({ambiguous:false});
  }
  expect(fetcher).not.toHaveBeenCalled();
  await new ConfiguredMetaMessageSender([pilot],fetcher).send(reply);
  expect(fetcher.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/9100/messages');
  await expect(new MetaMessageSender(pilot,vi.fn().mockRejectedValue(new Error('Synthetic timeout'))).send(reply)).rejects.toMatchObject({ambiguous:true,code:'network_outcome_unknown'});
 });
 it('rejects a wrong database tenant before privileged ingestion or job updates',async()=>{
  const rpc=vi.fn(),query={select:()=>query,eq:()=>query,single:async()=>({data:{tenant_id:other,mode:'pilot'}})};
  const db={from:()=>query,rpc} as unknown as SupabaseClient;
  const repo=new SupabaseMessagingRepository(db,'9100',pilot);
  await expect(repo.ingest({phoneNumberId:'9100',from:phone,providerMessageId:'in',occurredAt:new Date().toISOString(),type:'text',text:'Synthetic message'})).rejects.toThrow('Channel mismatch');
  const job={id:'job',tenant_id:other,inbound_message_id:'in',lease_token:'lease'};
  await expect(repo.context(job)).rejects.toThrow('Channel mismatch');
  expect(()=>repo.prepare(job,'Synthetic reply')).toThrow('Channel mismatch');expect(rpc).not.toHaveBeenCalled();
 });
 it('authenticates with the pilot secret, filters recipients and ignores phone-app echoes, history and group turns',async()=>{
  const ingest=vi.fn(),recordStatus=vi.fn(),repo={ingest,recordStatus,isAllowedIdentity:vi.fn().mockResolvedValue(false)} as unknown as MessagingRepository;
  const turn=(from:string,id:string)=>({from,id,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Synthetic message'}});
  const payload={object:'whatsapp_business_account',entry:[{changes:[
   {field:'history',value:{messages:'not an inbound turn'}},
   {field:'smb_message_echoes',value:{messages:[turn(phone,'echo')]}},
   {field:'messages',value:{metadata:{phone_number_id:'9100'},messages:[turn(phone,'approved'),turn(second,'unapproved'),{...turn(phone,'group'),group_id:'group'}, {...turn(phone,'echo-marked'),is_echo:true}]}}
  ]}]};
  const raw=JSON.stringify(payload);
  const request=(key:string)=>new Request('https://example.test/api/webhooks/whatsapp/pilot',{method:'POST',body:raw,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',key).update(raw).digest('hex')}});
  const options={appSecret:secret,phoneNumberId:'9100',recipients:[phone],repository:repo};
  expect((await receiveWebhook(request('other-app-secret'),options)).status).toBe(403);expect(ingest).not.toHaveBeenCalled();
  expect((await receiveWebhook(request(secret),options)).status).toBe(200);expect(ingest).toHaveBeenCalledOnce();
  expect(ingest.mock.calls[0][0].providerMessageId).toBe('approved');
 });
 it('requires an explicit dashboard channel when more than one is enabled',()=>{
  expect(availabilityChannel([{dashboard_active:false,id:'test'}])?.id).toBe('test');
  expect(availabilityChannel([{dashboard_active:false,id:'test'},{dashboard_active:false,id:'pilot'}])).toBeNull();
  expect(availabilityChannel([{dashboard_active:false,id:'test'},{dashboard_active:true,id:'pilot'}])?.id).toBe('pilot');
 });
});

describe('durable pilot guards',()=>{
 let db:PGlite,channel:string;
 const rows=async<T=Record<string,unknown>>(sql:string,args:unknown[]=[]) => (await db.query<T>(sql,args)).rows;
 const ingest=async(id:string,from=phone,user:string|null=null)=>rows<{v:string|null}>("select public.ingest_moderated_message('9100',$1,$2,null,now(),'text','Synthetic customer turn',$3) as v",[id,from,user]);
 const claim=async()=> (await rows<{id:string;lease_token:string}>("select * from public.claim_message_job('9100')"))[0];
 const prepare=async(job:{id:string;lease_token:string})=>(await rows<{v:PreparedReply|null}>("select public.prepare_message_reply($1,$2,'Synthetic reply') as v",[job.id,job.lease_token]))[0].v;
 async function authorize(sending=true,allowed=[phone,second]) {
  await db.query("insert into public.whatsapp_pilot_authorizations(tenant_id,channel_id,approved_at,receiving_enabled,sending_enabled,allowed_recipients) values($1,$2,now(),true,$3,$4)",[tenant,channel,sending,allowed]);
  await db.query("update public.whatsapp_channels set enabled=true where id=$1",[channel]);
 }
 async function selectChats(ids:string[]) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await db.exec('set role authenticated');
  await db.query("select public.set_assistant_availability($1,'selected',$2)",[channel,ids]);
  await db.exec('reset role');
 }
 async function conversations(){return rows<{id:string;customer_id:string}>('select id,customer_id from public.conversations where channel_id=$1 order by id',[channel]);}
 async function selectedTurn(id='selected'){
  await ingest('initial');const [c]=await conversations();await selectChats([c.id]);await ingest(id);await db.exec("update public.messages set moderation_state='clear'");return c;
 }
 beforeAll(async()=>{
  db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{
  await db.exec('reset role;truncate public.tenants,auth.users cascade');
  await db.query("insert into public.tenants(id,name,slug) values($1,'Synthetic pilot','pilot'),($2,'Other synthetic tenant','other')",[tenant,other]);
  await db.query('insert into auth.users values($1),($2)',[owner,viewer]);
  await db.query("insert into public.tenant_memberships values($1,$2,'owner'),($1,$3,'viewer')",[tenant,owner,viewer]);
  channel=(await rows<{id:string}>("insert into public.whatsapp_channels(tenant_id,phone_number_id,mode,assistant_scope) values($1,'9100','pilot','all') returning id",[tenant]))[0].id;
 });
 it('creates no live channel or authorization in the migration and defaults new pilot channels off',async()=>{
  expect(await rows('select enabled,assistant_scope from public.whatsapp_channels')).toEqual([{enabled:false,assistant_scope:'off'}]);
  expect(await rows('select * from public.whatsapp_pilot_authorizations')).toEqual([]);
  await expect(ingest('disabled')).rejects.toThrow('disabled');
  await db.query("update public.whatsapp_channels set enabled=true where id=$1",[channel]);
  await expect(ingest('not-approved')).rejects.toThrow('disabled');
  await expect(db.query("update public.whatsapp_channels set assistant_scope='all' where id=$1",[channel])).rejects.toThrow('whatsapp_pilot_scope_check');
 });
 it('requires receive approval, the database allowlist, send approval and a selected chat independently',async()=>{
  await authorize(false,[phone]);
  expect((await ingest('unapproved',second))[0].v).toBeNull();expect(await conversations()).toHaveLength(0);
  await selectedTurn();expect(await claim()).toBeUndefined();
  await db.query('update public.whatsapp_pilot_authorizations set sending_enabled=true where channel_id=$1',[channel]);
  expect(await claim()).toBeUndefined(); // Policy changes never replay old work.
  await ingest('fresh');await db.exec("update public.messages set moderation_state='clear'");
  const job=await claim();expect(job).toBeDefined();expect(await prepare(job)).toMatchObject({tenant_id:tenant,phone_number_id:'9100',recipient:phone});
 });
 it('deduplicates deliveries and retains uncertain sends for review without retry',async()=>{
  await authorize();await selectedTurn();
  const first=(await ingest('duplicate'))[0].v;expect((await ingest('duplicate'))[0].v).toBe(first);
  expect(await rows("select id from public.messages where provider_message_id='duplicate'")).toHaveLength(1);
  await db.exec("update public.messages set moderation_state='clear'");const job=await claim();await prepare(job);
  await db.query("select public.fail_message_job($1,$2,'needs_review','network_outcome_unknown')",[job.id,job.lease_token]);
  expect(await claim()).toBeUndefined();await expect(prepare(job)).rejects.toThrow('lease');
  expect(await rows("select id from public.messages where direction='outbound'")).toHaveLength(1);
 });
 it('recovers expired sends during a send pause and continues to settle receipts without replay',async()=>{
  await authorize();await selectedTurn();const job=await claim();const reply=await prepare(job);
  await db.query("update public.message_jobs set leased_until=now()-interval '1 minute' where id=$1",[job.id]);
  await db.query('update public.whatsapp_pilot_authorizations set sending_enabled=false,receiving_enabled=false where channel_id=$1',[channel]);
  await db.query("update public.whatsapp_channels set enabled=false where id=$1",[channel]);
  await db.query("select public.recover_pilot_sends('9100',$1)",[other]);
  expect((await rows<{state:string}>('select state from public.message_jobs where id=$1',[job.id]))[0].state).toBe('sending');
  await db.query("select public.recover_pilot_sends('9100',$1)",[tenant]);
  expect((await rows<{state:string}>('select state from public.message_jobs where id=$1',[job.id]))[0].state).toBe('needs_review');
  await db.query("update public.messages set provider_message_id='synthetic-delivery' where id=$1",[reply!.outbound_id]);
  await db.exec("select public.record_whatsapp_status('9100','synthetic-delivery','delivered',now(),null);select public.record_whatsapp_status('9100','synthetic-delivery','delivered',now(),null)");
  expect((await rows<{delivery_status:string}>('select delivery_status from public.messages where id=$1',[reply!.outbound_id]))[0].delivery_status).toBe('delivered');
  expect(await claim()).toBeUndefined();
 });
 it('blocks unselected, paused and revoked work, including an already claimed generation',async()=>{
  await authorize();const c=await selectedTurn();await ingest('other-person',second);
  await db.exec("update public.messages set moderation_state='clear'");const job=await claim();
  await db.query("update public.conversations set automation_mode='human',automation_epoch=automation_epoch+1 where id=$1",[c.id]);
  expect(await prepare(job)).toBeNull();expect(await claim()).toBeUndefined();
  await db.query("update public.conversations set automation_mode='auto' where id=$1",[c.id]);await ingest('before-revoke');const revoked=await claim();
  await db.query('update public.whatsapp_pilot_authorizations set sending_enabled=false where channel_id=$1',[channel]);
  await expect(prepare(revoked)).rejects.toThrow('lease');
  await db.query('update public.whatsapp_pilot_authorizations set sending_enabled=true where channel_id=$1',[channel]);
  expect(await claim()).toBeUndefined();
 });
 it('supports verified aliases without transferring approval to retired identities or other channels',async()=>{
  await authorize(true,[phone]);await ingest('paired',phone,'EG.Synthetic');
  expect((await ingest('hidden','EG.Synthetic','EG.Synthetic'))[0].v).toBeTruthy();
  await db.query("select public.update_whatsapp_identity('9100','change','EG.Synthetic',null,'EG.NewSynthetic',now())");
  expect((await ingest('after-change','EG.NewSynthetic','EG.NewSynthetic'))[0].v).toBeNull();
  await expect(db.query('insert into public.whatsapp_pilot_authorizations(tenant_id,channel_id) values($1,$2)',[other,channel])).rejects.toThrow();
 });
 it('protects service-only controls and manual sends with tenant membership and both allowlists',async()=>{
  await authorize();const c=await selectedTurn();await db.query("update public.conversations set automation_mode='human' where id=$1",[c.id]);
  const request='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const args=[owner,c.id,request,'Synthetic personal reply','9100',[phone]];
  await expect(db.query('select public.prepare_manual_reply($1,$2,$3,$4,$5,$6)',[viewer,...args.slice(1)])).rejects.toThrow('access denied');
  await expect(db.query('select public.prepare_manual_reply($1,$2,$3,$4,$5,$6)',[...args.slice(0,5),[second]])).rejects.toThrow('guard');
  expect((await rows<{v:{reply:PreparedReply}}> ('select public.prepare_manual_reply($1,$2,$3,$4,$5,$6) as v',args))[0].v.reply.tenant_id).toBe(tenant);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
  await expect(db.exec('select * from public.whatsapp_pilot_authorizations')).rejects.toThrow();
  await expect(db.query('select public.whatsapp_channel_active($1,true)',[channel])).rejects.toThrow();
  await expect(db.exec("update public.whatsapp_channels set mode='test'")).rejects.toThrow();
 });
});
