import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';

const tenant='11111111-1111-4111-8111-111111111111';
const otherTenant='22222222-2222-4222-8222-222222222222';
const user='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003'];

describe('persisted branch ordering',()=>{
  let db:PGlite;
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    await db.exec(await readFile(new URL('../supabase/migrations/202609120001_foundation.sql',import.meta.url),'utf8'));
    await db.query('insert into public.tenants(id,name,slug) values($1,$2,$3),($4,$5,$6)',[tenant,'Primary','primary',otherTenant,'Other','other']);
    for(const [index,id] of ids.entries())await db.query(`insert into public.business_facts(id,tenant_id,category,fact_key,locale,value,is_published,created_at)
      values($1,$2,'branch',$3,'en',$4,true,$5)`,[id,tenant,`branch:${id}`,JSON.stringify({name:`Branch ${index+1}`,address:'Address',hours:'Hours'}),new Date(Date.UTC(2026,0,index+1)).toISOString()]);
    await db.query(`insert into public.business_facts(tenant_id,category,fact_key,locale,value,is_published)
      values($1,'branch','branch:other','en',$2,true)`,[otherTenant,JSON.stringify({name:'Other',address:'Address',hours:'Hours'})]);
    await db.exec(await readFile(new URL('../supabase/migrations/202610040002_branch_order.sql',import.meta.url),'utf8'));
    await db.query('insert into auth.users(id) values($1)',[user]);
    await db.query("insert into public.tenant_memberships values($1,$2,'admin')",[tenant,user]);
  });
  afterAll(async()=>{await db?.close();});

  it('backfills the existing dashboard order and atomically saves a new complete order',async()=>{
    expect((await db.query<{id:string;display_order:number}>('select id,display_order from public.business_facts where tenant_id=$1 order by display_order',[tenant])).rows)
      .toEqual(ids.map((id,display_order)=>({id,display_order})));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
    await db.query('select public.reorder_branches($1,$2,$3::uuid[])',[tenant,'en',[ids[2],ids[0],ids[1]]]);
    expect((await db.query<{id:string}>('select id from public.business_facts where tenant_id=$1 order by display_order',[tenant])).rows.map(row=>row.id))
      .toEqual([ids[2],ids[0],ids[1]]);
    await expect(db.query('select public.reorder_branches($1,$2,$3::uuid[])',[tenant,'en',[ids[0],ids[1]]])).rejects.toThrow();
    await expect(db.query('select public.reorder_branches($1,$2,$3::uuid[])',[tenant,'en',[ids[0],ids[0],ids[1]]])).rejects.toThrow();
    await db.exec('reset role');
  });

  it('appends new branches and prevents cross-tenant or read-only reordering',async()=>{
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
    const added=(await db.query<{display_order:number}>(`insert into public.business_facts(tenant_id,category,fact_key,locale,value)
      values($1,'branch','branch:new','en',$2) returning display_order`,[tenant,JSON.stringify({name:'New',address:'Address',hours:'Hours'})])).rows[0];
    expect(added.display_order).toBe(3);
    await expect(db.query('select public.reorder_branches($1,$2,$3::uuid[])',[otherTenant,'en',[]])).rejects.toThrow('Owner or admin access required');
    await db.exec('reset role');await db.query("update public.tenant_memberships set role='viewer' where user_id=$1",[user]);await db.exec('set role authenticated');
    await expect(db.query('select public.reorder_branches($1,$2,$3::uuid[])',[tenant,'en',[]])).rejects.toThrow('Owner or admin access required');
    await db.exec('reset role');
  });
});
