begin;
-- Phone numbers remain phone numbers. Hidden-number customers have a NULL phone.
alter table public.customers alter column whatsapp_id drop not null;
alter table public.customers add column whatsapp_username text check (char_length(whatsapp_username) between 1 and 35);
alter table public.conversations add column reply_recipient text check (reply_recipient ~ '^([0-9]{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$');
update public.conversations c set reply_recipient=u.whatsapp_id from public.customers u where u.id=c.customer_id and u.tenant_id=c.tenant_id;

-- Scope every Meta identifier to the trusted receiving channel. Never join by username.
create table public.whatsapp_identities (
  tenant_id uuid not null references public.tenants(id), channel_id uuid not null, customer_id uuid not null,
  identifier text not null check (identifier ~ '^([0-9]{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$'),
  active boolean not null default true,
  foreign key(tenant_id,channel_id) references public.whatsapp_channels(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id),
  primary key(channel_id,identifier)
);
create index whatsapp_identity_customer on public.whatsapp_identities(tenant_id,channel_id,customer_id);
insert into public.whatsapp_identities(tenant_id,channel_id,customer_id,identifier)
  select distinct c.tenant_id,c.channel_id,c.customer_id,u.whatsapp_id from public.conversations c
  join public.customers u on u.id=c.customer_id and u.tenant_id=c.tenant_id where u.whatsapp_id is not null;
create table public.whatsapp_identity_events (
  tenant_id uuid not null references public.tenants(id), channel_id uuid not null, customer_id uuid not null,
  provider_message_id text not null, occurred_at timestamptz not null,
  foreign key(tenant_id,channel_id) references public.whatsapp_channels(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id),
  primary key(channel_id,provider_message_id)
);
alter table public.whatsapp_identities enable row level security;
alter table public.whatsapp_identity_events enable row level security;
-- Internal identity mapping is never browser-writable or browser-readable.
revoke all on public.whatsapp_identities,public.whatsapp_identity_events from public,anon,authenticated;
grant all on public.whatsapp_identities,public.whatsapp_identity_events to service_role;

create function public.is_allowed_whatsapp_identity(p_phone text,p_identifier text,p_allowed text[])
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.whatsapp_channels ch
    join public.whatsapp_identities i on i.channel_id=ch.id and i.tenant_id=ch.tenant_id and i.active
    join public.whatsapp_identities a on a.channel_id=i.channel_id and a.tenant_id=i.tenant_id and a.customer_id=i.customer_id and a.active
    where ch.phone_number_id=p_phone and ch.enabled and ch.mode='test' and i.identifier=p_identifier and a.identifier=any(p_allowed));
$$;
revoke all on function public.is_allowed_whatsapp_identity(text,text,text[]) from public,anon,authenticated;
grant execute on function public.is_allowed_whatsapp_identity(text,text,text[]) to service_role;

create function public.ingest_whatsapp_identity_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text,p_user_id text default null,p_username text default null)
returns uuid language plpgsql set search_path='' as $$
declare ch public.whatsapp_channels; cust uuid; conv uuid; msg uuid; candidates uuid[]; ids text[]; known_phone text;
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and enabled and mode='test';
  if ch.id is null then raise exception 'Unknown or disabled test channel'; end if;
  if p_from is null or p_from !~ '^([0-9]{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$'
    or (p_user_id is not null and p_user_id !~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$')
    or (p_from ~ '^[A-Z]' and p_user_id is not null and p_from<>p_user_id) then raise exception 'Invalid sender identity'; end if;
  if p_occurred > now()+interval '5 minutes' then raise exception 'Future message timestamp'; end if;
  perform pg_advisory_xact_lock(hashtextextended('identity:'||ch.id::text,0));
  select id into msg from public.messages where channel_id=ch.id and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  ids:=array_remove(array[p_from,p_user_id],null);
  if exists(select 1 from public.whatsapp_identities where channel_id=ch.id and identifier=any(ids) and not active) then raise exception 'Retired sender identity'; end if;
  select array_agg(distinct customer_id) into candidates from public.whatsapp_identities where channel_id=ch.id and identifier=any(ids);
  if cardinality(candidates)>1 then raise exception 'Conflicting sender identities'; end if;
  cust:=candidates[1];
  if p_from ~ '^[0-9]' then known_phone:=p_from; end if;
  -- Existing phone-only customers retain their row and all conversation history.
  if cust is null and known_phone is not null then select id into cust from public.customers where tenant_id=ch.tenant_id and whatsapp_id=known_phone; end if;
  if cust is not null and known_phone is not null and exists(select 1 from public.customers where id=cust and whatsapp_id is not null and whatsapp_id<>known_phone) then raise exception 'Identity change requires system event'; end if;
  if cust is null then
    insert into public.customers(tenant_id,whatsapp_id,display_name,whatsapp_username) values(ch.tenant_id,known_phone,p_name,p_username) returning id into cust;
  else
    update public.customers set whatsapp_id=coalesce(known_phone,whatsapp_id),display_name=coalesce(p_name,display_name),whatsapp_username=p_username where id=cust and tenant_id=ch.tenant_id;
  end if;
  insert into public.whatsapp_identities(tenant_id,channel_id,customer_id,identifier)
    select ch.tenant_id,ch.id,cust,id from (select distinct unnest(ids) as id) x on conflict(channel_id,identifier) do nothing;
  insert into public.conversations(tenant_id,customer_id,channel_id,last_inbound_at,reply_recipient)
    values(ch.tenant_id,cust,ch.id,p_occurred,p_from)
    on conflict(tenant_id,channel_id,customer_id) where status='open' do update set
      reply_recipient=case when excluded.last_inbound_at>=public.conversations.last_inbound_at then excluded.reply_recipient else public.conversations.reply_recipient end,
      last_inbound_at=greatest(public.conversations.last_inbound_at,excluded.last_inbound_at) returning id into conv;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,provider_message_id,message_type,body,occurred_at)
    values(ch.tenant_id,conv,ch.id,'inbound',p_provider_id,p_type,p_body,p_occurred) returning id into msg;
  insert into public.message_jobs(tenant_id,inbound_message_id) values(ch.tenant_id,msg);
  return msg;
end; $$;
revoke all on function public.ingest_whatsapp_identity_message(text,text,text,text,timestamptz,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ingest_whatsapp_identity_message(text,text,text,text,timestamptz,text,text,text,text) to service_role;
-- Preserve compatibility during deployment, including original permissions.
create or replace function public.ingest_whatsapp_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text)
returns uuid language sql set search_path='' as $$
  select public.ingest_whatsapp_identity_message(p_phone,p_provider_id,p_from,p_name,p_occurred,p_type,p_body,null,null);
$$;

-- Process signed system changes without generating a reply or extending the service window.
create function public.update_whatsapp_identity(p_phone text,p_provider_id text,p_previous text,p_new_phone text,p_new_user_id text,p_occurred timestamptz)
returns void language plpgsql set search_path='' as $$
declare ch public.whatsapp_channels; cust uuid; ids text[];
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and enabled and mode='test';
  if ch.id is null then raise exception 'Unknown or disabled test channel'; end if;
  if p_new_user_id is null or p_new_user_id !~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$'
    or (p_new_phone is not null and p_new_phone !~ '^[0-9]{7,15}$') then raise exception 'Invalid sender identity'; end if;
  if p_occurred>now()+interval '5 minutes' then raise exception 'Future identity timestamp'; end if;
  perform pg_advisory_xact_lock(hashtextextended('identity:'||ch.id::text,0));
  if exists(select 1 from public.whatsapp_identity_events where channel_id=ch.id and provider_message_id=p_provider_id) then return; end if;
  select customer_id into cust from public.whatsapp_identities where channel_id=ch.id and identifier=p_previous;
  if cust is null then return; end if;
  if exists(select 1 from public.whatsapp_identity_events where channel_id=ch.id and customer_id=cust and occurred_at>=p_occurred) then return; end if;
  if not exists(select 1 from public.whatsapp_identities where channel_id=ch.id and identifier=p_previous and active) then return; end if;
  ids:=array_remove(array[p_new_phone,p_new_user_id],null);
  if exists(select 1 from public.whatsapp_identities where channel_id=ch.id and identifier=any(ids) and customer_id<>cust) then raise exception 'Conflicting sender identities'; end if;
  update public.whatsapp_identities set active=false where channel_id=ch.id and customer_id=cust;
  insert into public.whatsapp_identities(tenant_id,channel_id,customer_id,identifier)
    select ch.tenant_id,ch.id,cust,id from unnest(ids) id on conflict(channel_id,identifier) do update set active=true;
  update public.customers set whatsapp_id=p_new_phone where id=cust and tenant_id=ch.tenant_id;
  update public.conversations set reply_recipient=coalesce(p_new_phone,p_new_user_id),automation_epoch=automation_epoch+1
    where channel_id=ch.id and customer_id=cust and tenant_id=ch.tenant_id;
  insert into public.whatsapp_identity_events values(ch.tenant_id,ch.id,cust,p_provider_id,p_occurred);
end; $$;
revoke all on function public.update_whatsapp_identity(text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.update_whatsapp_identity(text,text,text,text,text,timestamptz) to service_role;

create or replace function public.prepare_message_reply(p_job uuid,p_lease uuid,p_body text)
returns jsonb language plpgsql set search_path = '' as $$
declare j public.message_jobs; m public.messages; c public.conversations; ch public.whatsapp_channels; recipient text; aliases text[]; outbound uuid;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state <> 'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease'; end if;
  select * into m from public.messages where id=j.inbound_message_id;
  select * into c from public.conversations where id=m.conversation_id for update;
  select * into ch from public.whatsapp_channels where id=m.channel_id;
  if j.automation_epoch<>c.automation_epoch or c.automation_mode='human' or c.status<>'open' or not ch.enabled or ch.mode<>'test' or c.last_inbound_at<now()-interval '23 hours 55 minutes' then
    update public.message_jobs set state='skipped',error_code='handoff_closed_disabled_or_window_expired' where id=p_job;
    return null;
  end if;
  if p_body is null or char_length(p_body)=0 or char_length(p_body)>4096 then raise exception 'Invalid reply body'; end if;
  select coalesce(c.reply_recipient,whatsapp_id) into recipient from public.customers where id=c.customer_id and tenant_id=c.tenant_id;
  select coalesce(array_agg(identifier),array[]::text[]) into aliases from public.whatsapp_identities where channel_id=ch.id and tenant_id=c.tenant_id and customer_id=c.customer_id and active;
  if recipient is null then raise exception 'Missing reply identity'; end if;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,reply_to_message_id,delivery_status,occurred_at)
    values(m.tenant_id,m.conversation_id,m.channel_id,'outbound','text',p_body,m.id,'sending',now()) returning id into outbound;
  update public.message_jobs set state='sending',leased_until=now()+interval '2 minutes' where id=p_job;
  return jsonb_build_object('outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'recipient_aliases',to_jsonb(aliases),'body',p_body);
end; $$;

create or replace function public.prepare_manual_reply(p_actor uuid,p_conversation uuid,p_request uuid,p_body text,p_phone text,p_allowed text[])
returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; ch public.whatsapp_channels; existing public.manual_reply_requests; recipient text; aliases text[]; outbound uuid;
begin
  if p_request is null or p_body is null or char_length(btrim(p_body)) not between 1 and 4096 then raise exception 'Invalid reply'; end if;
  select * into c from public.conversations where id=p_conversation for update;
  if c.id is null or not exists(select 1 from public.tenant_memberships where tenant_id=c.tenant_id and user_id=p_actor and role in ('owner','admin','agent')) then raise exception 'Conversation access denied'; end if;
  select * into existing from public.manual_reply_requests where id=p_request;
  if existing.id is not null then
    if existing.tenant_id<>c.tenant_id or existing.conversation_id<>c.id or existing.actor_id<>p_actor or
      (select body from public.messages where id=existing.outbound_id) is distinct from p_body then raise exception 'Request identity conflict'; end if;
    return jsonb_build_object('state',existing.state);
  end if;
  select * into ch from public.whatsapp_channels where id=c.channel_id and tenant_id=c.tenant_id;
  select coalesce(c.reply_recipient,whatsapp_id) into recipient from public.customers where id=c.customer_id and tenant_id=c.tenant_id;
  select coalesce(array_agg(identifier),array[]::text[]) into aliases from public.whatsapp_identities where channel_id=ch.id and tenant_id=c.tenant_id and customer_id=c.customer_id and active;
  if recipient is null then raise exception 'Missing reply identity'; end if;
  if c.automation_mode<>'human' or c.status<>'open' or c.attention_state='resolved' then raise exception 'Pause the assistant before replying'; end if;
  if c.last_inbound_at<now()-interval '23 hours 55 minutes' then raise exception 'Customer service window expired'; end if;
  if ch.mode is distinct from 'test' or ch.enabled is distinct from true or ch.phone_number_id is distinct from p_phone
    or p_allowed is null or not (coalesce(recipient=any(p_allowed),false) or aliases && p_allowed) then raise exception 'Test guard rejected'; end if;
  update public.conversations set attention_state='in_progress',attention_since=coalesce(attention_since,now()) where id=c.id;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,delivery_status,occurred_at)
    values(c.tenant_id,c.id,ch.id,'outbound','text',p_body,'sending',now()) returning id into outbound;
  insert into public.manual_reply_requests(id,tenant_id,conversation_id,actor_id,outbound_id,state)
    values(p_request,c.tenant_id,c.id,p_actor,outbound,'sending');
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type) values(c.tenant_id,c.id,p_actor,'manual_reply');
  return jsonb_build_object('state','new','reply',jsonb_build_object('outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'recipient_aliases',to_jsonb(aliases),'body',p_body));
end; $$;

commit;
