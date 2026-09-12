begin;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);
create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner','admin','agent','viewer')),
  primary key (tenant_id, user_id)
);
create table public.whatsapp_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  phone_number_id text not null unique check (phone_number_id ~ '^[0-9]+$'),
  mode text not null default 'test' check (mode = 'test'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  whatsapp_id text not null check (whatsapp_id ~ '^[0-9]{7,15}$'),
  display_name text,
  preferred_language text,
  attributes jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, whatsapp_id), unique (tenant_id, id)
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  customer_id uuid not null,
  channel_id uuid not null,
  status text not null default 'open' check (status in ('open','closed')),
  automation_mode text not null default 'auto' check (automation_mode in ('auto','human')),
  summary text,
  last_inbound_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references public.customers(tenant_id,id),
  foreign key (tenant_id, channel_id) references public.whatsapp_channels(tenant_id,id),
  unique (tenant_id,id)
);
create unique index one_open_conversation on public.conversations(tenant_id,channel_id,customer_id) where status = 'open';
create index conversation_activity on public.conversations(tenant_id,last_inbound_at desc);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid not null,
  channel_id uuid not null,
  direction text not null check (direction in ('inbound','outbound')),
  provider_message_id text,
  message_type text not null,
  body text,
  reply_to_message_id uuid,
  delivery_status text not null default 'received' check (delivery_status in ('received','queued','sending','sent','delivered','read','failed','needs_review')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,conversation_id) references public.conversations(tenant_id,id),
  foreign key (tenant_id,channel_id) references public.whatsapp_channels(tenant_id,id),
  unique (tenant_id,id),
  unique (channel_id,provider_message_id),
  unique (reply_to_message_id),
  foreign key (tenant_id,reply_to_message_id) references public.messages(tenant_id,id)
);
create index message_history on public.messages(tenant_id,conversation_id,occurred_at);
create table public.business_facts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  category text not null,
  fact_key text not null,
  locale text not null default 'en',
  value jsonb not null,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,fact_key,locale)
);
create table public.faqs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  locale text not null default 'en',
  question text not null,
  answer text not null,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.message_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  inbound_message_id uuid not null unique,
  state text not null default 'pending' check (state in ('pending','processing','sending','completed','skipped','failed','needs_review')),
  attempts integer not null default 0,
  lease_token uuid,
  leased_until timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id,inbound_message_id) references public.messages(tenant_id,id)
);
create index pending_jobs on public.message_jobs(state,created_at);
create table public.message_status_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  channel_id uuid not null,
  provider_message_id text not null,
  status text not null check (status in ('sent','delivered','read','failed')),
  occurred_at timestamptz not null,
  error_code text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,channel_id) references public.whatsapp_channels(tenant_id,id),
  unique(channel_id,provider_message_id,status,occurred_at)
);

create function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;
create trigger touch_customers before update on public.customers for each row execute function public.touch_updated_at();
create trigger touch_conversations before update on public.conversations for each row execute function public.touch_updated_at();
create trigger touch_facts before update on public.business_facts for each row execute function public.touch_updated_at();
create trigger touch_faqs before update on public.faqs for each row execute function public.touch_updated_at();
create trigger touch_jobs before update on public.message_jobs for each row execute function public.touch_updated_at();

-- The only definer function: prevents recursive membership policies. No dynamic SQL.
create function public.is_tenant_member(p_tenant uuid, p_roles text[] default array['owner','admin','agent','viewer'])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.tenant_memberships where tenant_id=p_tenant and user_id=(select auth.uid()) and role=any(p_roles));
$$;
revoke all on function public.is_tenant_member(uuid,text[]) from public, anon;
grant execute on function public.is_tenant_member(uuid,text[]) to authenticated, service_role;

do $$ declare t text; begin
  foreach t in array array['tenants','tenant_memberships','whatsapp_channels','customers','conversations','messages','business_facts','faqs','message_jobs','message_status_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  foreach t in array array['customers','conversations','messages','business_facts','faqs'] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy tenant_read on public.%I for select to authenticated using (public.is_tenant_member(tenant_id))',t);
  end loop;
  foreach t in array array['business_facts','faqs'] loop
    execute format('grant insert, update, delete on table public.%I to authenticated',t);
    execute format('create policy knowledge_insert on public.%I for insert to authenticated with check(public.is_tenant_member(tenant_id,array[''owner'',''admin'']))',t);
    execute format('create policy knowledge_update on public.%I for update to authenticated using(public.is_tenant_member(tenant_id,array[''owner'',''admin''])) with check(public.is_tenant_member(tenant_id,array[''owner'',''admin'']))',t);
    execute format('create policy knowledge_delete on public.%I for delete to authenticated using(public.is_tenant_member(tenant_id,array[''owner'',''admin'']))',t);
  end loop;
end $$;
grant select on public.tenants, public.tenant_memberships to authenticated;
create policy own_tenants on public.tenants for select to authenticated using(public.is_tenant_member(id));
create policy own_membership on public.tenant_memberships for select to authenticated using(user_id=(select auth.uid()));

-- All ingestion writes and the durable job are committed together, or not at all.
create function public.ingest_whatsapp_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text)
returns uuid language plpgsql set search_path = '' as $$
declare ch public.whatsapp_channels; cust uuid; conv uuid; msg uuid;
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and enabled and mode='test';
  if ch.id is null then raise exception 'Unknown or disabled test channel'; end if;
  if p_occurred > now() + interval '5 minutes' then raise exception 'Future message timestamp'; end if;
  perform pg_advisory_xact_lock(hashtextextended(ch.id::text || p_from,0));
  select id into msg from public.messages where channel_id=ch.id and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  insert into public.customers(tenant_id,whatsapp_id,display_name) values(ch.tenant_id,p_from,p_name)
    on conflict(tenant_id,whatsapp_id) do update set display_name=coalesce(excluded.display_name,public.customers.display_name) returning id into cust;
  insert into public.conversations(tenant_id,customer_id,channel_id,last_inbound_at)
    values(ch.tenant_id,cust,ch.id,p_occurred)
    on conflict(tenant_id,channel_id,customer_id) where status='open'
    do update set last_inbound_at=greatest(public.conversations.last_inbound_at,excluded.last_inbound_at) returning id into conv;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,provider_message_id,message_type,body,occurred_at)
    values(ch.tenant_id,conv,ch.id,'inbound',p_provider_id,p_type,p_body,p_occurred) returning id into msg;
  insert into public.message_jobs(tenant_id,inbound_message_id) values(ch.tenant_id,msg);
  return msg;
end; $$;

create function public.claim_message_job(p_phone text)
returns setof public.message_jobs language plpgsql set search_path = '' as $$
declare job_id uuid;
begin
  -- Serializes claims per channel, while sends happen outside this transaction.
  perform pg_advisory_xact_lock(hashtextextended('claim:' || p_phone,0));
  update public.message_jobs j set state='needs_review',error_code='send_lease_expired'
    from public.messages m,public.whatsapp_channels ch
    where j.inbound_message_id=m.id and m.channel_id=ch.id and ch.phone_number_id=p_phone
      and j.state='sending' and j.leased_until < now();
  update public.messages m set delivery_status='needs_review'
    from public.message_jobs j,public.messages inbound,public.whatsapp_channels ch
    where m.reply_to_message_id=j.inbound_message_id and j.inbound_message_id=inbound.id
      and inbound.channel_id=ch.id and ch.phone_number_id=p_phone and j.state='needs_review' and m.delivery_status='sending';
  update public.message_jobs j set state=case when attempts>=3 then 'failed' else 'pending' end,error_code='processing_lease_expired'
    from public.messages m,public.whatsapp_channels ch
    where j.inbound_message_id=m.id and m.channel_id=ch.id and ch.phone_number_id=p_phone
      and j.state='processing' and j.leased_until < now();
  select j.id into job_id from public.message_jobs j
    join public.messages m on m.id=j.inbound_message_id
    join public.whatsapp_channels ch on ch.id=m.channel_id
    where j.state='pending' and ch.phone_number_id=p_phone and ch.enabled and ch.mode='test'
      and not exists(select 1 from public.message_jobs active join public.messages am on am.id=active.inbound_message_id
        where am.conversation_id=m.conversation_id and active.state in ('processing','sending'))
    order by j.created_at,j.id for update of j skip locked limit 1;
  return query update public.message_jobs set state='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes' where id=job_id returning *;
end; $$;

create function public.prepare_message_reply(p_job uuid,p_lease uuid,p_body text)
returns jsonb language plpgsql set search_path = '' as $$
declare j public.message_jobs; m public.messages; c public.conversations; ch public.whatsapp_channels; recipient text; outbound uuid;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state <> 'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease'; end if;
  select * into m from public.messages where id=j.inbound_message_id;
  select * into c from public.conversations where id=m.conversation_id for update;
  select * into ch from public.whatsapp_channels where id=m.channel_id;
  if c.automation_mode='human' or c.status<>'open' or not ch.enabled or ch.mode<>'test' or c.last_inbound_at<now()-interval '23 hours 55 minutes' then
    update public.message_jobs set state='skipped',error_code='handoff_closed_disabled_or_window_expired' where id=p_job;
    return null;
  end if;
  if p_body is null or char_length(p_body)=0 or char_length(p_body)>4096 then raise exception 'Invalid reply body'; end if;
  select whatsapp_id into recipient from public.customers where id=c.customer_id;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,reply_to_message_id,delivery_status,occurred_at)
    values(m.tenant_id,m.conversation_id,m.channel_id,'outbound','text',p_body,m.id,'sending',now()) returning id into outbound;
  update public.message_jobs set state='sending',leased_until=now()+interval '2 minutes' where id=p_job;
  return jsonb_build_object('outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'body',p_body);
end; $$;

create function public.complete_message_job(p_job uuid,p_lease uuid,p_provider_id text)
returns void language plpgsql set search_path = '' as $$
declare j public.message_jobs; ch uuid; best_status text;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state<>'sending' or j.lease_token is distinct from p_lease then raise exception 'Invalid sending lease'; end if;
  select channel_id into ch from public.messages where reply_to_message_id=j.inbound_message_id;
  perform pg_advisory_xact_lock(hashtextextended(ch::text || p_provider_id,1));
  select status into best_status from public.message_status_events where channel_id=ch and provider_message_id=p_provider_id
    order by case status when 'read' then 4 when 'delivered' then 3 when 'failed' then 2 else 1 end desc limit 1;
  update public.messages set provider_message_id=p_provider_id,delivery_status=coalesce(best_status,'sent') where reply_to_message_id=j.inbound_message_id;
  update public.message_jobs set state='completed',leased_until=null,error_code=null where id=p_job;
end; $$;
create function public.fail_message_job(p_job uuid,p_lease uuid,p_state text,p_code text)
returns void language plpgsql set search_path = '' as $$
declare j public.message_jobs;
begin
  if p_state not in ('failed','needs_review') then raise exception 'Invalid failure state'; end if;
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state<>'sending' or j.lease_token is distinct from p_lease then raise exception 'Invalid sending lease'; end if;
  update public.messages set delivery_status=p_state where reply_to_message_id=j.inbound_message_id;
  update public.message_jobs set state=p_state,error_code=p_code,leased_until=null where id=p_job;
end; $$;
create function public.record_whatsapp_status(p_phone text,p_provider_id text,p_status text,p_occurred timestamptz,p_code text)
returns void language plpgsql set search_path = '' as $$
declare ch public.whatsapp_channels; best_status text;
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and mode='test';
  if ch.id is null then raise exception 'Unknown test channel'; end if;
  perform pg_advisory_xact_lock(hashtextextended(ch.id::text || p_provider_id,1));
  insert into public.message_status_events(tenant_id,channel_id,provider_message_id,status,occurred_at,error_code)
    values(ch.tenant_id,ch.id,p_provider_id,p_status,p_occurred,p_code) on conflict do nothing;
  select status into best_status from public.message_status_events where channel_id=ch.id and provider_message_id=p_provider_id
    order by case status when 'read' then 4 when 'delivered' then 3 when 'failed' then 2 else 1 end desc limit 1;
  update public.messages set delivery_status=best_status where channel_id=ch.id and provider_message_id=p_provider_id and direction='outbound';
end; $$;

-- Deny browser/anonymous invocation of all mutation RPCs, even on projects with legacy default grants.
revoke all on function public.touch_updated_at() from public,anon,authenticated;
revoke all on function public.ingest_whatsapp_message(text,text,text,text,timestamptz,text,text) from public,anon,authenticated;
revoke all on function public.claim_message_job(text) from public,anon,authenticated;
revoke all on function public.prepare_message_reply(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.complete_message_job(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.fail_message_job(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.record_whatsapp_status(text,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.ingest_whatsapp_message(text,text,text,text,timestamptz,text,text),public.claim_message_job(text),public.prepare_message_reply(uuid,uuid,text),public.complete_message_job(uuid,uuid,text),public.fail_message_job(uuid,uuid,text,text),public.record_whatsapp_status(text,text,text,timestamptz,text) to service_role;
commit;
