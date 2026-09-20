import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',viewer='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
describe('blacklist and careers PostgreSQL boundaries',()=>{
 let db:PGlite;
 const rows=async<T=Record<string,unknown>>(sql:string,args:unknown[]=[])=> (await db.query<T>(sql,args)).rows;
 const ingest=async(id:string,from='201000000001',phone='9001',type='text')=>(await rows<{v:string}>("select public.ingest_moderated_message($1,$2,$3,'Fictional customer',now(),$4,'Synthetic content',null,null,$5) as v",[phone,id,from,type,type==='image'?'123':null]))[0].v;
 const claim=async()=>(await rows<{id:string;lease_token:string;inbound_message_id:string}>("select * from public.claim_message_job('9001')"))[0];
 const moderate=async(job:Awaited<ReturnType<typeof claim>>,state='clear',categories:string[]=[])=> (await rows<{v:boolean}>('select public.finish_content_check($1,$2,$3,$4) as v',[job.id,job.lease_token,state,categories]))[0].v;
 const prepare=async(job:Awaited<ReturnType<typeof claim>>) => (await rows<{v:unknown}>("select public.prepare_message_reply($1,$2,'Synthetic response') as v",[job.id,job.lease_token]))[0].v;
 async function asUser(user:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');}
 async function block(){await ingest('flag');const job=await claim();await moderate(job,'flagged',['sexual']);return(await rows<{customer_id:string;revision:number;state:string}>('select * from public.customer_blacklist'))[0];}
 const review=async(customer:string,action:string,revision:number,t=tenant)=>db.query('select public.review_blacklist($1,$2,$3,$4)',[t,customer,action,revision]);
 beforeAll(async()=>{db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");for(const file of(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));});
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{await db.exec('reset role;truncate public.tenants,auth.users cascade;');await db.query("insert into public.tenants(id,name,slug) values($1,'Demo','demo'),($2,'Other','other')",[tenant,other]);await db.query("insert into public.whatsapp_channels(tenant_id,phone_number_id) values($1,'9001'),($2,'9002')",[tenant,other]);await db.query('insert into auth.users values($1),($2)',[owner,viewer]);await db.query("insert into public.tenant_memberships values($1,$2,'owner'),($1,$3,'viewer')",[tenant,owner,viewer]);});
 it('atomically ingests media once and requires a successful content check before automatic send',async()=>{
  const id=await ingest('image',undefined,undefined,'image');expect(await ingest('image')).toBe(id);
  expect(await rows('select media_id,moderation_state from public.messages')).toEqual([{media_id:'123',moderation_state:'pending'}]);expect(await rows('select id from public.message_jobs')).toHaveLength(1);
  const job=await claim();expect(await prepare(job)).toBeNull();
  await ingest('safe');const safe=await claim();expect(await moderate(safe)).toBe(true);expect(await prepare(safe)).toBeTruthy();
 });
 it('blocks automatic and manual sends and preserves messages while waiting for review',async()=>{
  const b=await block();expect(b.state).toBe('pending_review');
  await ingest('blocked-next');const next=await claim();expect(await moderate(next)).toBe(false);expect(await rows('select id from public.messages')).toHaveLength(2);
  const c=(await rows<{id:string}>('select id from public.conversations'))[0];await db.query("update public.conversations set automation_mode='human' where id=$1",[c.id]);
  await expect(db.query("select public.prepare_manual_reply($1,$2,gen_random_uuid(),'Synthetic reply','9001',array['201000000001'])",[owner,c.id])).rejects.toThrow('blacklisted');
  await asUser(owner);await review(b.customer_id,'kept',b.revision);expect((await rows('select state from public.customer_blacklist'))[0].state).toBe('kept');
  await expect(review(b.customer_id,'removed',b.revision)).rejects.toThrow('changed');
 });
 it('unblocks future messages without replaying the backlog',async()=>{
  const b=await block();await ingest('during-block');await asUser(owner);await review(b.customer_id,'removed',b.revision);await db.exec('reset role');
  expect(await claim()).toBeUndefined();await ingest('after-unblock');const next=await claim();expect(await moderate(next)).toBe(true);expect(await prepare(next)).toBeTruthy();
  expect(await rows('select action from public.blacklist_events order by created_at')).toEqual([{action:'flagged'},{action:'removed'}]);
 });
 it('preserves a pre-existing human takeover when removing a block',async()=>{
  await ingest('human');await db.exec("update public.conversations set automation_mode='human'");const job=await claim();await moderate(job,'flagged',['sexual']);
  const b=(await rows<{customer_id:string;revision:number}>('select customer_id,revision from public.customer_blacklist'))[0];await asUser(owner);await review(b.customer_id,'removed',b.revision);await db.exec('reset role');
  expect((await rows('select automation_mode from public.conversations'))[0].automation_mode).toBe('human');
  await ingest('still-human');const next=await claim();expect(await moderate(next)).toBe(true);expect(await prepare(next)).toBeNull();
 });
 it('does not let an in-flight old moderation result re-block somebody after review',async()=>{
  const b=await block();await ingest('in-flight');const old=await claim();await asUser(owner);await review(b.customer_id,'removed',b.revision);await db.exec('reset role');
  expect(await moderate(old,'flagged',['harassment'])).toBe(false);expect((await rows('select state from public.customer_blacklist'))[0].state).toBe('removed');
 });
 it('reflags new abuse after removal but never repeats the original webhook',async()=>{
  const b=await block();await asUser(owner);await review(b.customer_id,'removed',b.revision);await db.exec('reset role');await ingest('flag');expect(await claim()).toBeUndefined();
  await ingest('new-abuse');expect(await moderate(await claim(),'flagged',['harassment/threatening'])).toBe(false);
  expect((await rows('select state,categories,revision from public.customer_blacklist'))[0]).toEqual({state:'pending_review',categories:['harassment/threatening'],revision:3});
 });
 it('routes check failures to attention without creating a blacklist entry or clearing an existing complaint flag',async()=>{
  await ingest('failure');await db.exec("update public.conversations set is_complaint=true");expect(await moderate(await claim(),'unavailable')).toBe(false);
  expect(await rows('select * from public.customer_blacklist')).toEqual([]);
  expect((await rows('select automation_mode,attention_reason,is_complaint from public.conversations'))[0]).toEqual({automation_mode:'human',attention_reason:'moderation_review',is_complaint:true});
 });
 it('enforces tenant RLS, admin-only review, private verdict writes and lease authentication',async()=>{
  const b=await block();await ingest('other','201000000002','9002');
  await asUser(viewer);expect(await rows('select customer_id from public.customer_blacklist')).toHaveLength(1);await expect(review(b.customer_id,'removed',b.revision)).rejects.toThrow('access denied');
  await expect(db.exec("update public.customer_blacklist set state='removed'")).rejects.toThrow();
  await asUser(owner);await expect(review(b.customer_id,'removed',b.revision,other)).rejects.toThrow('access denied');
  await db.exec('set role anon');await expect(db.exec('select * from public.customer_blacklist')).rejects.toThrow();await expect(db.exec("select public.finish_content_check(gen_random_uuid(),gen_random_uuid(),'clear',array[]::text[])")).rejects.toThrow();
  await db.exec('reset role');await ingest('lease','201000000003');const j=await claim();await expect(moderate({...j,lease_token:owner})).rejects.toThrow('lease');
 });
 it('counts active blacklist indicators through membership RLS, excluding removed and other-tenant blocks',async()=>{
  const b=await block();
  await ingest('other-flag','201000000002','9002');
  const otherJob=(await rows<{id:string;lease_token:string;inbound_message_id:string}>("select * from public.claim_message_job('9002')"))[0];
  await moderate(otherJob,'flagged',['sexual']);
  const count=async()=>Number((await rows<{count:number}>("select count(*) from public.customer_blacklist where state in ('pending_review','kept')"))[0].count);
  await asUser(owner);expect(await count()).toBe(1);
  await review(b.customer_id,'kept',b.revision);expect(await count()).toBe(1);
  await review(b.customer_id,'removed',b.revision+1);expect(await count()).toBe(0);
  await db.exec('reset role');expect(await count()).toBe(1);
 });
 it('keeps a block attached to a customer through verified BSUID identity changes',async()=>{
  const b=await block();await db.query("select public.update_whatsapp_identity('9001','change','201000000001',null,'EG.NewUser',now())");
  await ingest('hidden','EG.NewUser');expect(await moderate(await claim())).toBe(false);expect((await rows('select customer_id from public.customer_blacklist'))[0].customer_id).toBe(b.customer_id);
 });
 it('persists the role and conditional follow-up purpose and validates career completion',async()=>{
  async function step(id:string,contact:unknown){await ingest(id);const job=await claim();await moderate(job);const r=await rows<{v:{outbound_id:string}}>("select public.prepare_followup_reply($1,$2,'Synthetic career reply',$3,'[]','career_application','Role to review',$4) as v",[job.id,job.lease_token,(contact as {state:string}).state==='ready'?'handoff':'clarify',JSON.stringify(contact)]);await db.query("select public.complete_message_job($1,$2,$3)",[job.id,job.lease_token,'out-'+id]);return r;}
  await step('career',{purpose:'career',role:null,state:'collecting',name:null,phone:null});await step('role',{purpose:'career',role:'Sales assistant',state:'collecting',name:null,phone:null});await step('contact',{purpose:'career',role:'Sales assistant',state:'ready',name:'Maya Hassan',phone:'201000000001'});
  expect((await rows('select followup_purpose,followup_role,followup_state,attention_reason,automation_mode from public.conversations'))[0]).toEqual({followup_purpose:'career',followup_role:'Sales assistant',followup_state:'ready',attention_reason:'career_application',automation_mode:'human'});
  await expect(db.exec("update public.conversations set followup_role=null")).rejects.toThrow('career_ready_role');
 });
});
