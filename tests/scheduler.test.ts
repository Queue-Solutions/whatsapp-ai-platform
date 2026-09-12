import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercise the real scheduler SQL with local stand-ins for hosted extensions.
// Actual cron execution and HTTP delivery still require hosted verification.
const setup = readFileSync('supabase/operations/configure-worker.sql','utf8')
  .replace(/^create extension.*;$/gm,'');
const tenant='11111111-1111-4111-8111-111111111111';
let db:PGlite;
beforeEach(async()=>{
  db=new PGlite();
  await db.exec(`
    create schema vault; create schema cron; create schema net;
    create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
    create table cron.job(jobname text primary key, schedule text, command text);
    create function cron.schedule(text,text,text) returns bigint language plpgsql as $$
    begin insert into cron.job values($1,$2,$3) on conflict(jobname) do update
      set schedule=excluded.schedule,command=excluded.command; return 1; end; $$;
    create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb,timeout integer);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
      returns bigint language plpgsql as $$ declare result bigint; begin
      insert into net.requests(url,headers,body,timeout) values($1,$2,$3,$4) returning id into result; return result; end; $$;
    create table public.whatsapp_channels(id text,tenant_id uuid,mode text);
    create table public.messages(id text,tenant_id uuid,channel_id text);
    create table public.message_jobs(inbound_message_id text,tenant_id uuid,state text,leased_until timestamptz);
  `);
});
afterEach(async()=>{await db.close();});
async function config(){
  await db.query('insert into vault.decrypted_secrets values ($1,$2),($3,$4)',[
    'queue_dev_worker_url','https://example-dev.vercel.app/api/internal/process-messages',
    'queue_dev_worker_secret','unit-test-only-worker-secret-1234567890']);
}
async function work(state:string,expired=false,owner=tenant){
  const id=crypto.randomUUID();
  await db.query('insert into whatsapp_channels values($1,$2,$3)',[id,owner,'test']);
  await db.query('insert into messages values($1,$2,$3)',[id,owner,id]);
  await db.query('insert into message_jobs values($1,$2,$3,$4)',[id,owner,state,new Date(Date.now()+(expired?-60000:60000)).toISOString()]);
}
async function tick(){
  const {rows}=await db.query<{command:string}>('select command from cron.job');
  await db.exec(rows[0].command);
}
describe('Supabase recovery scheduling',()=>{
  it('requires a configured HTTPS worker and secret before scheduling',async()=>{
    await expect(db.exec(setup)).rejects.toThrow('Configure the deployed Vercel worker URL');
    await db.exec('rollback');await config();
    await db.query('update vault.decrypted_secrets set decrypted_secret=$1 where name=$2',['https://unexpected.example/worker','queue_dev_worker_url']);
    await expect(db.exec(setup)).rejects.toThrow('Configure the deployed Vercel worker URL');
  });
  it('updates one named job and sends no credentials or requests while idle',async()=>{
    await config();await db.exec(setup);await db.exec(setup);
    const {rows}=await db.query<{command:string}>('select command from cron.job');
    expect(rows).toHaveLength(1);expect(rows[0].command).not.toContain('unit-test-only-worker-secret');
    for(const state of ['completed','failed','needs_review','skipped','processing','sending'])await work(state);
    await work('pending',false,'22222222-2222-4222-8222-222222222222');
    await tick();expect((await db.query('select * from net.requests')).rows).toHaveLength(0);
    await work('pending');await tick();
    const requests=await db.query<{url:string;headers:Record<string,string>;timeout:number}>('select url,headers,timeout from net.requests');
    expect(requests.rows).toHaveLength(1);
    expect(requests.rows[0]).toMatchObject({url:'https://example-dev.vercel.app/api/internal/process-messages',headers:{Authorization:'Bearer unit-test-only-worker-secret-1234567890'},timeout:55000});
  });
  it('wakes the existing worker for expired leases so recovery policy remains centralized',async()=>{
    await config();await db.exec(setup);await work('sending',true);await tick();
    expect((await db.query('select * from net.requests')).rows).toHaveLength(1);
    expect((await db.query<{state:string}>('select state from message_jobs')).rows[0].state).toBe('sending');
  });
});
