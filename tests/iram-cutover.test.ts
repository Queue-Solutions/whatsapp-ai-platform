import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';

const tenant='11111111-1111-4111-8111-111111111111',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const recipient='201000000001',migration='20261110023000_iram_dashboard_recipients.sql';

describe('IRAM-only cutover migration',()=>{
  let db:PGlite;
  const rows=async<T=Record<string,unknown>>(sql:string,args:unknown[]=[]) => (await db.query<T>(sql,args)).rows;
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");
    const files=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort();
    for(const file of files.filter(file=>file!==migration))await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    await db.query("insert into public.tenants(id,name,slug) values($1,'IRAM','iram')",[tenant]);
    await db.query('insert into auth.users values($1)',[owner]);
    await db.query("insert into public.tenant_memberships values($1,$2,'owner')",[tenant,owner]);
    await db.query("insert into public.business_facts(tenant_id,category,fact_key,value,is_published) values($1,'company','preserved',jsonb_build_object('value','knowledge'),true)",[tenant]);
    const test=(await rows<{id:string}>("insert into public.whatsapp_channels(tenant_id,phone_number_id,mode) values($1,'9001','test') returning id",[tenant]))[0].id;
    const pilot=(await rows<{id:string}>("insert into public.whatsapp_channels(tenant_id,phone_number_id,mode,dashboard_active) values($1,'9100','pilot',true) returning id",[tenant]))[0].id;
    await db.query("insert into public.whatsapp_pilot_authorizations(tenant_id,channel_id,approved_at,receiving_enabled,sending_enabled,allowed_recipients) values($1,$2,now(),true,false,$3)",[tenant,pilot,[recipient]]);
    await db.query('update public.whatsapp_channels set enabled=true where id=$1',[pilot]);
    await db.query("select public.ingest_whatsapp_message('9001','old-test',$1,'Old test contact',now(),'text','Synthetic old turn')",[recipient]);
    await db.query("select public.ingest_whatsapp_message('9100','current-iram',$1,'IRAM tester',now(),'text','Synthetic pilot turn')",[recipient]);
    expect(await rows('select id from public.conversations')).toHaveLength(2);
    await db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
    expect(test).not.toBe(pilot);
  });
  afterAll(async()=>{await db?.close();});
  it('deletes only obsolete test-channel platform data and preserves IRAM, customers and knowledge',async()=>{
    expect(await rows("select phone_number_id,mode from public.whatsapp_channels order by phone_number_id")).toEqual([{phone_number_id:'9100',mode:'pilot'}]);
    expect(await rows("select provider_message_id from public.messages")).toEqual([{provider_message_id:'current-iram'}]);
    expect(await rows('select id from public.conversations')).toHaveLength(1);
    expect(await rows('select whatsapp_id from public.customers')).toEqual([{whatsapp_id:recipient}]);
    expect(await rows("select fact_key from public.business_facts")).toEqual([{fact_key:'preserved'}]);
    expect(await rows('select recipient,conversation_id from public.assistant_approved_recipients')).toMatchObject([{recipient,conversation_id:expect.any(String)}]);
  });
});
