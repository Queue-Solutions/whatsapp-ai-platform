begin;
-- No client rows, credentials, approvals, selections or schedules are created here.
alter table public.whatsapp_channels drop constraint whatsapp_channels_mode_check;
alter table public.whatsapp_channels add constraint whatsapp_channels_mode_check check(mode in ('test','pilot'));
alter table public.whatsapp_channels add constraint whatsapp_pilot_scope_check check(mode<>'pilot' or assistant_scope in ('off','selected'));
alter table public.whatsapp_channels add column dashboard_active boolean not null default false;
create unique index whatsapp_dashboard_channel on public.whatsapp_channels(tenant_id) where dashboard_active and enabled;

-- Second, service-only gate, independent of deployment configuration and the UI.
create table public.whatsapp_pilot_authorizations (
  tenant_id uuid not null, channel_id uuid primary key,
  approved_at timestamptz,
  receiving_enabled boolean not null default false,
  sending_enabled boolean not null default false,
  allowed_recipients text[] not null default array[]::text[],
  foreign key(tenant_id,channel_id) references public.whatsapp_channels(tenant_id,id),
  check(not sending_enabled or receiving_enabled),
  check(not receiving_enabled or (approved_at is not null and cardinality(allowed_recipients)>0)),
  check(array_position(allowed_recipients,null) is null)
);
alter table public.whatsapp_pilot_authorizations enable row level security;
revoke all on public.whatsapp_pilot_authorizations from public,anon,authenticated;
grant all on public.whatsapp_pilot_authorizations to service_role;

create function public.whatsapp_channel_active(p_channel uuid,p_sending boolean default false)
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.whatsapp_channels ch
    where ch.id=p_channel and ch.enabled and (ch.mode='test' or (ch.mode='pilot' and exists(
      select 1 from public.whatsapp_pilot_authorizations p where p.channel_id=ch.id and p.tenant_id=ch.tenant_id
        and p.approved_at is not null and p.receiving_enabled and (not p_sending or p.sending_enabled)))));
$$;
create function public.whatsapp_pilot_recipient_allowed(p_channel uuid,p_identifier text,p_aliases text[] default array[]::text[])
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.whatsapp_channels ch where ch.id=p_channel and
    (ch.mode='test' or (ch.mode='pilot' and exists(select 1 from public.whatsapp_pilot_authorizations p
      where p.channel_id=ch.id and p.tenant_id=ch.tenant_id and p.approved_at is not null and p.receiving_enabled
        and (p_identifier=any(p.allowed_recipients) or p_aliases && p.allowed_recipients or exists(
          select 1 from public.whatsapp_identities i join public.whatsapp_identities a
            on a.channel_id=i.channel_id and a.tenant_id=i.tenant_id and a.customer_id=i.customer_id and a.active
          where i.channel_id=ch.id and i.tenant_id=ch.tenant_id and i.active and i.identifier=p_identifier
            and a.identifier=any(p.allowed_recipients)))))));
$$;
-- Changing the approval never replays messages collected under an older policy.
-- Sending intents are deliberately left intact: uncertain sends must not retry.
create function public.invalidate_pilot_work() returns trigger language plpgsql set search_path='' as $$
declare channel uuid;
begin
  if tg_op='UPDATE' and new is not distinct from old then return new; end if;
  if tg_op='DELETE' then channel:=old.channel_id; else channel:=new.channel_id; end if;
  if tg_op='UPDATE' and (new.channel_id<>old.channel_id or new.tenant_id<>old.tenant_id) then
    raise exception 'Pilot authorization binding is immutable';
  end if;
  update public.conversations set automation_epoch=automation_epoch+1 where channel_id=channel;
  update public.message_jobs j set state='skipped',error_code='pilot_authorization_changed',leased_until=null
    from public.messages m where j.inbound_message_id=m.id and m.channel_id=channel and j.state in ('pending','processing');
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
create trigger pilot_authorization_changed after insert or update or delete on public.whatsapp_pilot_authorizations
  for each row execute function public.invalidate_pilot_work();
-- New pilot channels begin off regardless of a caller's supplied default.
create function public.initialize_pilot_channel() returns trigger language plpgsql set search_path='' as $$
begin
  if new.mode='pilot' then new.assistant_scope:='off';new.enabled:=false; end if;
  return new;
end; $$;
create trigger initialize_pilot_channel before insert on public.whatsapp_channels
  for each row execute function public.initialize_pilot_channel();
-- A deployment-level send pause must still settle expired intents for review.
create function public.recover_pilot_sends(p_phone text,p_tenant uuid)
returns void language plpgsql set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('claim:'||p_phone,0));
  update public.message_jobs j set state='needs_review',error_code='send_lease_expired'
    from public.messages m,public.whatsapp_channels ch
    where j.inbound_message_id=m.id and m.channel_id=ch.id and m.tenant_id=p_tenant and ch.tenant_id=p_tenant
      and ch.mode='pilot' and ch.phone_number_id=p_phone and j.state='sending' and j.leased_until<now();
  update public.messages m set delivery_status='needs_review'
    from public.message_jobs j,public.messages inbound,public.whatsapp_channels ch
    where m.reply_to_message_id=j.inbound_message_id and j.inbound_message_id=inbound.id and inbound.channel_id=ch.id
      and m.tenant_id=p_tenant and ch.tenant_id=p_tenant and ch.mode='pilot' and ch.phone_number_id=p_phone
      and j.state='needs_review' and m.delivery_status='sending';
end; $$;
revoke all on function public.recover_pilot_sends(text,uuid) from public,anon,authenticated;
grant execute on function public.recover_pilot_sends(text,uuid) to service_role;
revoke all on function public.whatsapp_channel_active(uuid,boolean),public.whatsapp_pilot_recipient_allowed(uuid,text,text[]),public.invalidate_pilot_work(),public.initialize_pilot_channel() from public,anon,authenticated;
grant execute on function public.whatsapp_channel_active(uuid,boolean),public.whatsapp_pilot_recipient_allowed(uuid,text,text[]),public.invalidate_pilot_work(),public.initialize_pilot_channel() to service_role;

create or replace function public.is_allowed_whatsapp_identity(p_phone text,p_identifier text,p_allowed text[])
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.whatsapp_channels ch
    join public.whatsapp_identities i on i.channel_id=ch.id and i.tenant_id=ch.tenant_id and i.active
    join public.whatsapp_identities a on a.channel_id=i.channel_id and a.tenant_id=i.tenant_id and a.customer_id=i.customer_id and a.active
    where ch.phone_number_id=p_phone and public.whatsapp_channel_active(ch.id) and public.whatsapp_pilot_recipient_allowed(ch.id,p_identifier) and i.identifier=p_identifier and a.identifier=any(p_allowed));
$$;

create or replace function public.ingest_whatsapp_identity_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text,p_user_id text default null,p_username text default null)
returns uuid language plpgsql set search_path='' as $$
declare ch public.whatsapp_channels; cust uuid; conv uuid; msg uuid; candidates uuid[]; ids text[]; known_phone text;
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and public.whatsapp_channel_active(id);
  if ch.id is null then raise exception 'Unknown or disabled test channel'; end if;
  if p_from is null or p_from !~ '^([0-9]{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$'
    or (p_user_id is not null and p_user_id !~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$')
    or (p_from ~ '^[A-Z]' and p_user_id is not null and p_from<>p_user_id) then raise exception 'Invalid sender identity'; end if;
  if p_occurred > now()+interval '5 minutes' then raise exception 'Future message timestamp'; end if;
  perform pg_advisory_xact_lock(hashtextextended('identity:'||ch.id::text,0));
  select id into msg from public.messages where channel_id=ch.id and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  if not public.whatsapp_pilot_recipient_allowed(ch.id,p_from,array_remove(array[p_user_id],null)) then return null; end if;
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

create or replace function public.update_whatsapp_identity(p_phone text,p_provider_id text,p_previous text,p_new_phone text,p_new_user_id text,p_occurred timestamptz)
returns void language plpgsql set search_path='' as $$
declare ch public.whatsapp_channels; cust uuid; ids text[];
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and public.whatsapp_channel_active(id);
  if ch.id is null then raise exception 'Unknown or disabled test channel'; end if;
  if not public.whatsapp_pilot_recipient_allowed(ch.id,p_previous) then return; end if;
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

create or replace function public.ingest_moderated_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text,p_user_id text default null,p_username text default null,p_media_id text default null)
returns uuid language plpgsql set search_path='' as $$
declare ch uuid; msg uuid;
begin
  select id into ch from public.whatsapp_channels where phone_number_id=p_phone and public.whatsapp_channel_active(id);
  if ch is null then raise exception 'Unknown or disabled test channel'; end if;
  perform pg_advisory_xact_lock(hashtextextended('identity:'||ch::text,0));
  select id into msg from public.messages where channel_id=ch and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  msg:=public.ingest_whatsapp_identity_message(p_phone,p_provider_id,p_from,p_name,p_occurred,p_type,p_body,p_user_id,p_username);
  update public.messages set media_id=p_media_id,moderation_state='pending' where id=msg;
  return msg;
end; $$;

create or replace function public.claim_message_job(p_phone text)
returns setof public.message_jobs language plpgsql set search_path='' as $$
declare job_id uuid;
begin
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
  update public.message_jobs j set state='skipped',error_code='assistant_availability_disabled'
    from public.messages m,public.conversations c,public.whatsapp_channels ch
    where j.inbound_message_id=m.id and m.conversation_id=c.id and m.channel_id=ch.id
      and ch.phone_number_id=p_phone and j.state='pending'
      and (ch.assistant_scope='off' or (ch.assistant_scope='selected' and not exists(
        select 1 from public.assistant_selected_conversations s
          where s.tenant_id=ch.tenant_id and s.channel_id=ch.id and s.conversation_id=c.id)));
  update public.message_jobs j set state='skipped',error_code='superseded_by_newer_inbound'
    from public.messages m,public.whatsapp_channels ch
    where j.inbound_message_id=m.id and m.channel_id=ch.id and ch.phone_number_id=p_phone and j.state='pending'
      and exists(select 1 from public.messages newer
        where newer.tenant_id=m.tenant_id and newer.conversation_id=m.conversation_id
          and newer.direction='inbound' and newer.created_at>m.created_at);
  select j.id into job_id from public.message_jobs j
    join public.messages m on m.id=j.inbound_message_id
    join public.conversations c on c.id=m.conversation_id and c.tenant_id=m.tenant_id
    join public.whatsapp_channels ch on ch.id=m.channel_id
    where j.state='pending' and ch.phone_number_id=p_phone and public.whatsapp_channel_active(ch.id,true)
      and (ch.mode='test' or ch.assistant_scope='selected')
      and public.whatsapp_pilot_recipient_allowed(ch.id,c.reply_recipient)
      and (ch.assistant_scope='all' or (ch.assistant_scope='selected' and exists(
        select 1 from public.assistant_selected_conversations s
          where s.tenant_id=ch.tenant_id and s.channel_id=ch.id and s.conversation_id=c.id)))
      and not exists(select 1 from public.message_jobs active join public.messages am on am.id=active.inbound_message_id
        where am.conversation_id=m.conversation_id and active.state in ('processing','sending'))
    order by j.created_at,j.id for update of j skip locked limit 1;
  return query update public.message_jobs set state='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes' where id=job_id returning *;
end; $$;

create or replace function public.prepare_message_reply(p_job uuid,p_lease uuid,p_body text)
returns jsonb language plpgsql set search_path='' as $$
declare j public.message_jobs; m public.messages; c public.conversations; ch public.whatsapp_channels; recipient text; aliases text[]; outbound uuid; availability_denied boolean; superseded boolean;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease'; end if;
  select * into m from public.messages where id=j.inbound_message_id;
  select * into c from public.conversations where id=m.conversation_id for update;
  select * into ch from public.whatsapp_channels where id=m.channel_id;
  availability_denied:=ch.assistant_scope='off' or (ch.assistant_scope='selected' and not exists(
    select 1 from public.assistant_selected_conversations s
      where s.tenant_id=ch.tenant_id and s.channel_id=ch.id and s.conversation_id=c.id));
  superseded:=exists(
    select 1 from public.messages newer
      where newer.tenant_id=m.tenant_id and newer.conversation_id=m.conversation_id
        and newer.direction='inbound' and newer.created_at>m.created_at
  );
  if superseded then
    update public.message_jobs set state='skipped',error_code='superseded_by_newer_inbound',leased_until=null where id=p_job;
    return null;
  end if;
  if m.moderation_state not in ('legacy','clear') or exists(select 1 from public.customer_blacklist where tenant_id=c.tenant_id and customer_id=c.customer_id and state<>'removed') or j.automation_epoch<>c.automation_epoch or c.automation_mode='human' or c.status<>'open' or not public.whatsapp_channel_active(ch.id,true) or (ch.mode='pilot' and ch.assistant_scope<>'selected') or availability_denied or c.last_inbound_at<now()-interval '23 hours 55 minutes' then
    update public.message_jobs set state='skipped',error_code=case when availability_denied then 'assistant_availability_disabled' else 'handoff_closed_disabled_or_window_expired' end where id=p_job;
    return null;
  end if;
  if p_body is null or char_length(p_body)=0 or char_length(p_body)>4096 then raise exception 'Invalid reply body'; end if;
  select coalesce(c.reply_recipient,whatsapp_id) into recipient from public.customers where id=c.customer_id and tenant_id=c.tenant_id;
  select coalesce(array_agg(identifier),array[]::text[]) into aliases from public.whatsapp_identities where channel_id=ch.id and tenant_id=c.tenant_id and customer_id=c.customer_id and active;
  if recipient is null then raise exception 'Missing reply identity'; end if;
  if not public.whatsapp_pilot_recipient_allowed(ch.id,recipient,aliases) then
    update public.message_jobs set state='skipped',error_code='pilot_recipient_denied' where id=p_job;return null;
  end if;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,reply_to_message_id,delivery_status,occurred_at)
    values(m.tenant_id,m.conversation_id,m.channel_id,'outbound','text',p_body,m.id,'sending',now()) returning id into outbound;
  update public.message_jobs set state='sending',leased_until=now()+interval '2 minutes' where id=p_job;
  return jsonb_build_object('tenant_id',ch.tenant_id,'outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'recipient_aliases',to_jsonb(aliases),'body',p_body);
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
  if exists(select 1 from public.customer_blacklist where tenant_id=c.tenant_id and customer_id=c.customer_id and state<>'removed') then raise exception 'Customer is blacklisted'; end if;
  select * into ch from public.whatsapp_channels where id=c.channel_id and tenant_id=c.tenant_id;
  select coalesce(c.reply_recipient,whatsapp_id) into recipient from public.customers where id=c.customer_id and tenant_id=c.tenant_id;
  select coalesce(array_agg(identifier),array[]::text[]) into aliases from public.whatsapp_identities where channel_id=ch.id and tenant_id=c.tenant_id and customer_id=c.customer_id and active;
  if recipient is null then raise exception 'Missing reply identity'; end if;
  if c.automation_mode<>'human' or c.status<>'open' or c.attention_state='resolved' then raise exception 'Pause the assistant before replying'; end if;
  if c.last_inbound_at<now()-interval '23 hours 55 minutes' then raise exception 'Customer service window expired'; end if;
  if not public.whatsapp_channel_active(ch.id,true) or not public.whatsapp_pilot_recipient_allowed(ch.id,recipient,aliases) or ch.phone_number_id is distinct from p_phone
    or p_allowed is null or not (coalesce(recipient=any(p_allowed),false) or aliases && p_allowed) then raise exception 'Test guard rejected'; end if;
  update public.conversations set attention_state='in_progress',attention_since=coalesce(attention_since,now()) where id=c.id;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,delivery_status,occurred_at)
    values(c.tenant_id,c.id,ch.id,'outbound','text',p_body,'sending',now()) returning id into outbound;
  insert into public.manual_reply_requests(id,tenant_id,conversation_id,actor_id,outbound_id,state)
    values(p_request,c.tenant_id,c.id,p_actor,outbound,'sending');
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type) values(c.tenant_id,c.id,p_actor,'manual_reply');
  return jsonb_build_object('state','new','reply',jsonb_build_object('tenant_id',ch.tenant_id,'outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'recipient_aliases',to_jsonb(aliases),'body',p_body));
end; $$;

create or replace function public.record_whatsapp_status(p_phone text,p_provider_id text,p_status text,p_occurred timestamptz,p_code text)
returns void language plpgsql set search_path = '' as $$
declare ch public.whatsapp_channels; best_status text;
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and (mode='test' or (mode='pilot' and exists(select 1 from public.whatsapp_pilot_authorizations p where p.channel_id=whatsapp_channels.id and p.tenant_id=whatsapp_channels.tenant_id and p.approved_at is not null)));
  if ch.id is null then raise exception 'Unknown test channel'; end if;
  perform pg_advisory_xact_lock(hashtextextended(ch.id::text || p_provider_id,1));
  insert into public.message_status_events(tenant_id,channel_id,provider_message_id,status,occurred_at,error_code)
    values(ch.tenant_id,ch.id,p_provider_id,p_status,p_occurred,p_code) on conflict do nothing;
  select status into best_status from public.message_status_events where channel_id=ch.id and provider_message_id=p_provider_id
    order by case status when 'read' then 4 when 'delivered' then 3 when 'failed' then 2 else 1 end desc limit 1;
  update public.messages set delivery_status=best_status where channel_id=ch.id and provider_message_id=p_provider_id and direction='outbound';
end; $$;

-- CREATE OR REPLACE retains existing service-only grants on the guarded RPCs.
commit;
