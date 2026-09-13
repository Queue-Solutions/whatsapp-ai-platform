begin;
-- A pause/resume boundary invalidates old automatic work, even if it has not been claimed yet.
alter table public.conversations add column automation_epoch bigint not null default 0;
alter table public.message_jobs add column automation_epoch bigint not null default 0;
create function public.stamp_job_epoch() returns trigger language plpgsql set search_path='' as $$
begin
  select c.automation_epoch into strict new.automation_epoch from public.messages m
    join public.conversations c on c.id=m.conversation_id and c.tenant_id=m.tenant_id
    where m.id=new.inbound_message_id and m.tenant_id=new.tenant_id;
  return new;
end; $$;
create trigger stamp_job_epoch before insert on public.message_jobs for each row execute function public.stamp_job_epoch();
revoke all on function public.stamp_job_epoch() from public,anon,authenticated;

create table public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid not null,
  actor_id uuid references auth.users(id),
  event_type text not null check(event_type in ('paused','resumed','manual_reply')),
  created_at timestamptz not null default now(),
  foreign key(tenant_id,conversation_id) references public.conversations(tenant_id,id)
);
create table public.manual_reply_requests (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid not null,
  actor_id uuid not null references auth.users(id),
  outbound_id uuid not null unique,
  state text not null check(state in ('sending','sent','failed','needs_review')),
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key(tenant_id,conversation_id) references public.conversations(tenant_id,id),
  foreign key(tenant_id,outbound_id) references public.messages(tenant_id,id)
);
alter table public.conversation_events enable row level security;
alter table public.manual_reply_requests enable row level security;
revoke all on public.conversation_events,public.manual_reply_requests from public,anon,authenticated;
grant all on public.conversation_events,public.manual_reply_requests to service_role;
grant select on public.conversation_events,public.manual_reply_requests to authenticated;
create policy tenant_events_read on public.conversation_events for select to authenticated using(public.is_tenant_member(tenant_id));
create policy tenant_manual_read on public.manual_reply_requests for select to authenticated using(public.is_tenant_member(tenant_id));
create index conversation_event_history on public.conversation_events(tenant_id,conversation_id,created_at);
create index manual_pending on public.manual_reply_requests(state,created_at);

-- The browser has no direct conversation UPDATE grant. This narrow, audited function authenticates the actor.
create function public.set_conversation_mode(p_conversation uuid,p_mode text,p_expected timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare c public.conversations;
begin
  if p_mode is null or p_mode not in ('auto','human') or p_expected is null then raise exception 'Invalid mode request'; end if;
  select * into c from public.conversations where id=p_conversation
    and public.is_tenant_member(tenant_id,array['owner','admin','agent']) for update;
  if c.id is null then raise exception 'Conversation access denied'; end if;
  if c.updated_at is distinct from p_expected then raise exception 'Conversation changed; refresh first'; end if;
  if c.status<>'open' then raise exception 'Conversation is closed'; end if;
  if c.automation_mode=p_mode then return; end if;
  update public.conversations set automation_mode=p_mode,automation_epoch=automation_epoch+1 where id=c.id;
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type)
    values(c.tenant_id,c.id,auth.uid(),case when p_mode='human' then 'paused' else 'resumed' end);
end; $$;
revoke all on function public.set_conversation_mode(uuid,text,timestamptz) from public,anon;
grant execute on function public.set_conversation_mode(uuid,text,timestamptz) to authenticated;

create or replace function public.prepare_message_reply(p_job uuid,p_lease uuid,p_body text)
returns jsonb language plpgsql set search_path = '' as $$
declare j public.message_jobs; m public.messages; c public.conversations; ch public.whatsapp_channels; recipient text; outbound uuid;
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
  select whatsapp_id into recipient from public.customers where id=c.customer_id;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,reply_to_message_id,delivery_status,occurred_at)
    values(m.tenant_id,m.conversation_id,m.channel_id,'outbound','text',p_body,m.id,'sending',now()) returning id into outbound;
  update public.message_jobs set state='sending',leased_until=now()+interval '2 minutes' where id=p_job;
  return jsonb_build_object('outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'body',p_body);
end; $$;


-- Only the authenticated server handler calls this with its verified user and configured test allowlist.
create function public.prepare_manual_reply(p_actor uuid,p_conversation uuid,p_request uuid,p_body text,p_phone text,p_allowed text[])
returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; ch public.whatsapp_channels; existing public.manual_reply_requests; recipient text; outbound uuid;
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
  select whatsapp_id into recipient from public.customers where id=c.customer_id and tenant_id=c.tenant_id;
  if c.automation_mode<>'human' or c.status<>'open' then raise exception 'Pause the assistant before replying'; end if;
  if c.last_inbound_at<now()-interval '23 hours 55 minutes' then raise exception 'Customer service window expired'; end if;
  if ch.mode is distinct from 'test' or ch.enabled is distinct from true or ch.phone_number_id is distinct from p_phone
    or p_allowed is null or not coalesce(recipient=any(p_allowed),false) then raise exception 'Test guard rejected'; end if;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,delivery_status,occurred_at)
    values(c.tenant_id,c.id,ch.id,'outbound','text',p_body,'sending',now()) returning id into outbound;
  insert into public.manual_reply_requests(id,tenant_id,conversation_id,actor_id,outbound_id,state)
    values(p_request,c.tenant_id,c.id,p_actor,outbound,'sending');
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type) values(c.tenant_id,c.id,p_actor,'manual_reply');
  return jsonb_build_object('state','new','reply',jsonb_build_object('outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'body',p_body));
end; $$;

create function public.finish_manual_reply(p_request uuid,p_state text,p_provider text,p_error text)
returns void language plpgsql set search_path='' as $$
declare r public.manual_reply_requests; ch uuid; best text;
begin
  if p_state is null or p_state not in ('sent','failed','needs_review') then raise exception 'Invalid send state'; end if;
  select * into r from public.manual_reply_requests where id=p_request for update;
  if r.id is null then raise exception 'Unknown reply'; end if;
  if r.state<>'sending' then return; end if;
  if p_state='sent' then
    if p_provider is null or char_length(p_provider)=0 then raise exception 'Missing provider identity'; end if;
    select channel_id into ch from public.messages where id=r.outbound_id;
    perform pg_advisory_xact_lock(hashtextextended(ch::text || p_provider,1));
    select status into best from public.message_status_events where channel_id=ch and provider_message_id=p_provider
      order by case status when 'read' then 4 when 'delivered' then 3 when 'failed' then 2 else 1 end desc limit 1;
    update public.messages set provider_message_id=p_provider,delivery_status=coalesce(best,'sent') where id=r.outbound_id;
  else
    update public.messages set delivery_status=p_state where id=r.outbound_id;
  end if;
  update public.manual_reply_requests set state=p_state,error_code=p_error,completed_at=now() where id=r.id;
end; $$;

create function public.expire_manual_replies() returns void language plpgsql set search_path='' as $$
begin
  with expired as (
    update public.manual_reply_requests set state='needs_review',error_code='manual_send_timeout',completed_at=now()
      where state='sending' and created_at<now()-interval '2 minutes' returning outbound_id
  ) update public.messages set delivery_status='needs_review' where id in(select outbound_id from expired) and delivery_status='sending';
end; $$;
revoke all on function public.prepare_manual_reply(uuid,uuid,uuid,text,text,text[]),public.finish_manual_reply(uuid,text,text,text),public.expire_manual_replies() from public,anon,authenticated;
grant execute on function public.prepare_manual_reply(uuid,uuid,uuid,text,text,text[]),public.finish_manual_reply(uuid,text,text,text),public.expire_manual_replies() to service_role;
commit;
