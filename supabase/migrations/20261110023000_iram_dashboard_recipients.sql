begin;

-- One canonical representation prevents the same Egyptian mobile from being
-- approved twice under 010..., +2010..., 002010..., Arabic digits or spacing.
create function public.normalize_egypt_mobile(p_value text)
returns text language plpgsql immutable strict set search_path='' as $$
declare digits text;
begin
  digits:=regexp_replace(translate(normalize(p_value,nfkc),'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'[^0-9]','','g');
  if digits like '0020%' then digits:=substr(digits,3); end if;
  if digits ~ '^01[0125][0-9]{8}$' then digits:='20'||substr(digits,2);
  elsif digits ~ '^1[0125][0-9]{8}$' then digits:='20'||digits;
  end if;
  if digits !~ '^201[0125][0-9]{8}$' then return null; end if;
  return digits;
end; $$;
revoke all on function public.normalize_egypt_mobile(text) from public,anon;
grant execute on function public.normalize_egypt_mobile(text) to authenticated,service_role;

create table public.assistant_approved_recipients(
  tenant_id uuid not null references public.tenants(id),
  channel_id uuid not null,
  recipient text not null check(recipient ~ '^201[0125][0-9]{8}$'),
  display_name text check(display_name is null or char_length(display_name) between 1 and 120),
  conversation_id uuid,
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(channel_id,recipient),
  foreign key(tenant_id,channel_id) references public.whatsapp_channels(tenant_id,id),
  foreign key(tenant_id,conversation_id) references public.conversations(tenant_id,id)
);
create unique index assistant_approved_conversation on public.assistant_approved_recipients(channel_id,conversation_id) where conversation_id is not null;
create index assistant_approved_tenant on public.assistant_approved_recipients(tenant_id,channel_id);
create trigger touch_assistant_approved_recipients before update on public.assistant_approved_recipients
  for each row execute function public.touch_updated_at();
alter table public.assistant_approved_recipients enable row level security;
revoke all on public.assistant_approved_recipients from public,anon,authenticated;
grant all on public.assistant_approved_recipients to service_role;
grant select on public.assistant_approved_recipients to authenticated;
create policy tenant_assistant_approved_read on public.assistant_approved_recipients for select to authenticated
  using(public.is_tenant_member(tenant_id));

-- Preserve the already approved pilot testers, but move the operational source
-- of truth away from deployment variables and into the dashboard database.
insert into public.assistant_approved_recipients(tenant_id,channel_id,recipient,approved_by)
select p.tenant_id,p.channel_id,normalized,
  (select tm.user_id from public.tenant_memberships tm where tm.tenant_id=p.tenant_id and tm.role in ('owner','admin') order by case tm.role when 'owner' then 0 else 1 end,tm.user_id limit 1)
from public.whatsapp_pilot_authorizations p
cross join lateral unnest(p.allowed_recipients) raw(value)
cross join lateral (select public.normalize_egypt_mobile(raw.value) normalized) n
where normalized is not null
on conflict(channel_id,recipient) do nothing;

create function public.invalidate_approved_recipient_work() returns trigger language plpgsql set search_path='' as $$
declare target_channel uuid;target_conversation uuid;
begin
  target_channel:=case when tg_op='DELETE' then old.channel_id else new.channel_id end;
  target_conversation:=case when tg_op='DELETE' then old.conversation_id else new.conversation_id end;
  if tg_op='UPDATE' and new.channel_id<>old.channel_id then raise exception 'Recipient channel is immutable'; end if;
  if target_conversation is not null then
    update public.conversations set automation_epoch=automation_epoch+1 where id=target_conversation;
    update public.message_jobs j set state='skipped',error_code='assistant_recipient_approval_changed',leased_until=null
      from public.messages m where j.inbound_message_id=m.id and m.conversation_id=target_conversation and j.state in ('pending','processing');
  end if;
  if tg_op='DELETE' and old.conversation_id is not null then
    delete from public.assistant_selected_conversations where channel_id=old.channel_id and conversation_id=old.conversation_id;
  elsif tg_op<>'DELETE' and new.conversation_id is not null then
    insert into public.assistant_selected_conversations(tenant_id,channel_id,conversation_id,selected_by)
      values(new.tenant_id,new.channel_id,new.conversation_id,coalesce(new.approved_by,(select user_id from public.tenant_memberships where tenant_id=new.tenant_id order by user_id limit 1)))
      on conflict(channel_id,conversation_id) do nothing;
  end if;
  return case when tg_op='DELETE' then old else new end;
end; $$;
create trigger approved_recipient_changed after insert or update or delete on public.assistant_approved_recipients
  for each row execute function public.invalidate_approved_recipient_work();
revoke all on function public.invalidate_approved_recipient_work() from public,anon,authenticated;
grant execute on function public.invalidate_approved_recipient_work() to service_role;

with matches as (
  select a.channel_id,a.recipient,(select c.id from public.conversations c join public.customers u
    on u.id=c.customer_id and u.tenant_id=c.tenant_id
    where c.tenant_id=a.tenant_id and c.channel_id=a.channel_id and c.status='open' and (
      public.normalize_egypt_mobile(u.whatsapp_id)=a.recipient or exists(select 1 from public.whatsapp_identities i
        where i.tenant_id=a.tenant_id and i.channel_id=a.channel_id and i.customer_id=c.customer_id and i.active
          and public.normalize_egypt_mobile(i.identifier)=a.recipient))
    order by c.last_inbound_at desc limit 1) conversation_id
  from public.assistant_approved_recipients a
)
update public.assistant_approved_recipients a set conversation_id=m.conversation_id from matches m
  where a.channel_id=m.channel_id and a.recipient=m.recipient and m.conversation_id is not null;

create function public.approve_assistant_recipient(p_channel uuid,p_phone text,p_name text default null)
returns text language plpgsql security definer set search_path='' as $$
declare ch public.whatsapp_channels;canonical text;conv uuid;
begin
  canonical:=public.normalize_egypt_mobile(p_phone);
  if canonical is null or (p_name is not null and char_length(btrim(p_name)) not between 1 and 120) then raise exception 'Invalid Egyptian mobile'; end if;
  select * into ch from public.whatsapp_channels where id=p_channel and mode='pilot' and dashboard_active
    and public.is_tenant_member(tenant_id,array['owner','admin']) for update;
  if ch.id is null then raise exception 'Channel access denied'; end if;
  select c.id into conv from public.conversations c join public.customers u on u.id=c.customer_id and u.tenant_id=c.tenant_id
    where c.tenant_id=ch.tenant_id and c.channel_id=ch.id and c.status='open' and (
      public.normalize_egypt_mobile(u.whatsapp_id)=canonical or exists(select 1 from public.whatsapp_identities i
        where i.tenant_id=ch.tenant_id and i.channel_id=ch.id and i.customer_id=c.customer_id and i.active
          and public.normalize_egypt_mobile(i.identifier)=canonical))
    order by c.last_inbound_at desc limit 1;
  insert into public.assistant_approved_recipients(tenant_id,channel_id,recipient,display_name,conversation_id,approved_by)
    values(ch.tenant_id,ch.id,canonical,nullif(btrim(p_name),''),conv,auth.uid())
    on conflict(channel_id,recipient) do update set display_name=coalesce(excluded.display_name,public.assistant_approved_recipients.display_name),
      conversation_id=coalesce(excluded.conversation_id,public.assistant_approved_recipients.conversation_id),approved_by=auth.uid();
  return canonical;
end; $$;
create function public.remove_assistant_recipient(p_channel uuid,p_phone text)
returns void language plpgsql security definer set search_path='' as $$
declare ch public.whatsapp_channels;canonical text;
begin
  canonical:=public.normalize_egypt_mobile(p_phone);
  if canonical is null then raise exception 'Invalid Egyptian mobile'; end if;
  select * into ch from public.whatsapp_channels where id=p_channel and mode='pilot' and dashboard_active
    and public.is_tenant_member(tenant_id,array['owner','admin']) for update;
  if ch.id is null then raise exception 'Channel access denied'; end if;
  delete from public.assistant_approved_recipients where tenant_id=ch.tenant_id and channel_id=ch.id and recipient=canonical;
end; $$;
revoke all on function public.approve_assistant_recipient(uuid,text,text),public.remove_assistant_recipient(uuid,text) from public,anon;
grant execute on function public.approve_assistant_recipient(uuid,text,text),public.remove_assistant_recipient(uuid,text) to authenticated;

create or replace function public.whatsapp_pilot_recipient_allowed(p_channel uuid,p_identifier text,p_aliases text[] default array[]::text[])
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.whatsapp_channels ch where ch.id=p_channel and (
    ch.mode='test' or (ch.mode='pilot' and exists(select 1 from public.whatsapp_pilot_authorizations p
      where p.channel_id=ch.id and p.tenant_id=ch.tenant_id and p.approved_at is not null and p.receiving_enabled)
      and (exists(select 1 from public.assistant_approved_recipients a where a.channel_id=ch.id and a.tenant_id=ch.tenant_id
            and a.recipient=public.normalize_egypt_mobile(p_identifier))
        or exists(select 1 from public.whatsapp_identities i join public.whatsapp_identities linked
              on linked.channel_id=i.channel_id and linked.tenant_id=i.tenant_id and linked.customer_id=i.customer_id and linked.active
            join public.assistant_approved_recipients a on a.channel_id=linked.channel_id and a.tenant_id=linked.tenant_id
              and a.recipient=public.normalize_egypt_mobile(linked.identifier)
            where i.channel_id=ch.id and i.tenant_id=ch.tenant_id and i.active
              and (i.identifier=p_identifier or i.identifier=any(p_aliases)))))));
$$;

create or replace function public.is_allowed_whatsapp_identity(p_phone text,p_identifier text,p_allowed text[])
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.whatsapp_channels ch where ch.phone_number_id=p_phone
    and public.whatsapp_channel_active(ch.id) and (
      (ch.mode='pilot' and public.whatsapp_pilot_recipient_allowed(ch.id,p_identifier)) or
      (ch.mode='test' and exists(select 1 from public.whatsapp_identities i join public.whatsapp_identities a
        on a.channel_id=i.channel_id and a.tenant_id=i.tenant_id and a.customer_id=i.customer_id and a.active
        where i.channel_id=ch.id and i.tenant_id=ch.tenant_id and i.active and i.identifier=p_identifier and a.identifier=any(p_allowed)))));
$$;

create or replace function public.ingest_whatsapp_identity_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text,p_user_id text default null,p_username text default null)
returns uuid language plpgsql set search_path='' as $$
declare ch public.whatsapp_channels;cust uuid;conv uuid;msg uuid;candidates uuid[];ids text[];known_phone text;sender text;approver uuid;
begin
  select * into ch from public.whatsapp_channels where phone_number_id=p_phone and public.whatsapp_channel_active(id);
  if ch.id is null then raise exception 'Unknown or disabled WhatsApp channel'; end if;
  sender:=coalesce(public.normalize_egypt_mobile(p_from),p_from);
  if sender is null or sender !~ '^([0-9]{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$'
    or (p_user_id is not null and p_user_id !~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$')
    or (sender ~ '^[A-Z]' and p_user_id is not null and sender<>p_user_id) then raise exception 'Invalid sender identity'; end if;
  if p_occurred>now()+interval '5 minutes' then raise exception 'Future message timestamp'; end if;
  perform pg_advisory_xact_lock(hashtextextended('identity:'||ch.id::text,0));
  select id into msg from public.messages where channel_id=ch.id and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  if not public.whatsapp_pilot_recipient_allowed(ch.id,sender,array_remove(array[p_user_id],null)) then return null; end if;
  ids:=array_remove(array[sender,p_user_id],null);
  if exists(select 1 from public.whatsapp_identities where channel_id=ch.id and identifier=any(ids) and not active) then raise exception 'Retired sender identity'; end if;
  select array_agg(distinct customer_id) into candidates from public.whatsapp_identities where channel_id=ch.id and identifier=any(ids);
  if cardinality(candidates)>1 then raise exception 'Conflicting sender identities'; end if;
  cust:=candidates[1];if sender ~ '^[0-9]' then known_phone:=sender; end if;
  if cust is null and known_phone is not null then select id into cust from public.customers where tenant_id=ch.tenant_id and whatsapp_id=known_phone; end if;
  if cust is not null and known_phone is not null and exists(select 1 from public.customers where id=cust and whatsapp_id is not null and whatsapp_id<>known_phone) then raise exception 'Identity change requires system event'; end if;
  if cust is null then insert into public.customers(tenant_id,whatsapp_id,display_name,whatsapp_username) values(ch.tenant_id,known_phone,p_name,p_username) returning id into cust;
  else update public.customers set whatsapp_id=coalesce(known_phone,whatsapp_id),display_name=coalesce(p_name,display_name),whatsapp_username=p_username where id=cust and tenant_id=ch.tenant_id;end if;
  insert into public.whatsapp_identities(tenant_id,channel_id,customer_id,identifier)
    select ch.tenant_id,ch.id,cust,id from (select distinct unnest(ids) id)x on conflict(channel_id,identifier) do nothing;
  insert into public.conversations(tenant_id,customer_id,channel_id,last_inbound_at,reply_recipient)
    values(ch.tenant_id,cust,ch.id,p_occurred,sender)
    on conflict(tenant_id,channel_id,customer_id) where status='open' do update set
      reply_recipient=case when excluded.last_inbound_at>=public.conversations.last_inbound_at then excluded.reply_recipient else public.conversations.reply_recipient end,
      last_inbound_at=greatest(public.conversations.last_inbound_at,excluded.last_inbound_at) returning id into conv;
  if known_phone is not null then
    select approved_by into approver from public.assistant_approved_recipients where channel_id=ch.id and recipient=known_phone;
    update public.assistant_approved_recipients set conversation_id=conv where channel_id=ch.id and recipient=known_phone and conversation_id is distinct from conv;
    if found then insert into public.assistant_selected_conversations(tenant_id,channel_id,conversation_id,selected_by)
      values(ch.tenant_id,ch.id,conv,coalesce(approver,(select user_id from public.tenant_memberships where tenant_id=ch.tenant_id order by user_id limit 1)))
      on conflict(channel_id,conversation_id) do nothing;end if;
  end if;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,provider_message_id,message_type,body,occurred_at)
    values(ch.tenant_id,conv,ch.id,'inbound',p_provider_id,p_type,p_body,p_occurred) returning id into msg;
  insert into public.message_jobs(tenant_id,inbound_message_id) values(ch.tenant_id,msg);
  return msg;
end; $$;

create or replace function public.set_assistant_availability(p_channel uuid,p_scope text,p_selected uuid[] default array[]::uuid[])
returns void language plpgsql security definer set search_path='' as $$
declare ch public.whatsapp_channels;chosen uuid[];approved uuid[];combined uuid[];previous uuid[];invalid_selection boolean;approval_count integer;
begin
  if p_channel is null or p_scope is null or p_scope not in ('all','off','selected') or p_selected is null then raise exception 'Invalid assistant availability';end if;
  select * into ch from public.whatsapp_channels where id=p_channel and public.is_tenant_member(tenant_id) for update;
  if ch.id is null then raise exception 'Channel access denied';end if;
  select coalesce(array_agg(value order by value),array[]::uuid[]) into chosen from(select distinct unnest(p_selected)value)s;
  select coalesce(array_agg(conversation_id order by conversation_id) filter(where conversation_id is not null),array[]::uuid[]),count(*)
    into approved,approval_count from public.assistant_approved_recipients where tenant_id=ch.tenant_id and channel_id=ch.id;
  select coalesce(array_agg(value order by value),array[]::uuid[]) into combined from(select distinct unnest(chosen||approved)value)s;
  if p_scope='selected' and cardinality(combined)=0 and approval_count=0 then raise exception 'Approve at least one recipient';end if;
  select exists(select 1 from unnest(combined)s(conversation_id) left join public.conversations c
    on c.id=s.conversation_id and c.tenant_id=ch.tenant_id and c.channel_id=ch.id and c.status='open' where c.id is null) into invalid_selection;
  if invalid_selection then raise exception 'Invalid conversation selection';end if;
  select coalesce(array_agg(conversation_id order by conversation_id),array[]::uuid[]) into previous from public.assistant_selected_conversations where tenant_id=ch.tenant_id and channel_id=ch.id;
  if ch.assistant_scope=p_scope and previous=combined then return;end if;
  delete from public.assistant_selected_conversations where tenant_id=ch.tenant_id and channel_id=ch.id and not(conversation_id=any(combined));
  insert into public.assistant_selected_conversations(tenant_id,channel_id,conversation_id,selected_by)
    select ch.tenant_id,ch.id,s.conversation_id,auth.uid() from unnest(combined)s(conversation_id) on conflict(channel_id,conversation_id) do nothing;
  update public.whatsapp_channels set assistant_scope=p_scope where id=ch.id;
  update public.conversations set automation_epoch=automation_epoch+1 where tenant_id=ch.tenant_id and channel_id=ch.id and status='open';
  update public.message_jobs j set state='skipped',error_code='assistant_availability_changed' from public.messages m
    where j.inbound_message_id=m.id and j.tenant_id=ch.tenant_id and m.channel_id=ch.id and j.state='pending';
  insert into public.assistant_availability_events(tenant_id,channel_id,actor_id,previous_scope,new_scope,selected_count)
    values(ch.tenant_id,ch.id,auth.uid(),ch.assistant_scope,p_scope,cardinality(combined));
end; $$;

-- Database-prepared replies carry an explicit marker required by the final
-- transport guard. The database approval is rechecked immediately beforehand.
create or replace function public.prepare_message_reply(p_job uuid,p_lease uuid,p_body text)
returns jsonb language plpgsql set search_path='' as $$
declare j public.message_jobs;m public.messages;c public.conversations;ch public.whatsapp_channels;recipient text;aliases text[];outbound uuid;availability_denied boolean;superseded boolean;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease';end if;
  select * into m from public.messages where id=j.inbound_message_id;select * into c from public.conversations where id=m.conversation_id for update;select * into ch from public.whatsapp_channels where id=m.channel_id;
  availability_denied:=ch.assistant_scope='off' or(ch.assistant_scope='selected' and not exists(select 1 from public.assistant_selected_conversations s where s.tenant_id=ch.tenant_id and s.channel_id=ch.id and s.conversation_id=c.id));
  superseded:=exists(select 1 from public.messages newer where newer.tenant_id=m.tenant_id and newer.conversation_id=m.conversation_id and newer.direction='inbound' and newer.created_at>m.created_at);
  if superseded then update public.message_jobs set state='skipped',error_code='superseded_by_newer_inbound',leased_until=null where id=p_job;return null;end if;
  if m.moderation_state not in('legacy','clear') or exists(select 1 from public.customer_blacklist where tenant_id=c.tenant_id and customer_id=c.customer_id and state<>'removed') or j.automation_epoch<>c.automation_epoch or c.automation_mode='human' or c.status<>'open' or not public.whatsapp_channel_active(ch.id,true) or(ch.mode='pilot' and ch.assistant_scope<>'selected') or availability_denied or c.last_inbound_at<now()-interval '23 hours 55 minutes' then
    update public.message_jobs set state='skipped',error_code=case when availability_denied then'assistant_availability_disabled'else'handoff_closed_disabled_or_window_expired'end where id=p_job;return null;end if;
  if p_body is null or char_length(p_body)=0 or char_length(p_body)>4096 then raise exception 'Invalid reply body';end if;
  select coalesce(c.reply_recipient,whatsapp_id) into recipient from public.customers where id=c.customer_id and tenant_id=c.tenant_id;
  select coalesce(array_agg(identifier),array[]::text[]) into aliases from public.whatsapp_identities where channel_id=ch.id and tenant_id=c.tenant_id and customer_id=c.customer_id and active;
  if recipient is null then raise exception 'Missing reply identity';end if;
  if not public.whatsapp_pilot_recipient_allowed(ch.id,recipient,aliases) then update public.message_jobs set state='skipped',error_code='pilot_recipient_denied' where id=p_job;return null;end if;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,reply_to_message_id,delivery_status,occurred_at)
    values(m.tenant_id,m.conversation_id,m.channel_id,'outbound','text',p_body,m.id,'sending',now()) returning id into outbound;
  update public.message_jobs set state='sending',leased_until=now()+interval '2 minutes' where id=p_job;
  return jsonb_build_object('tenant_id',ch.tenant_id,'outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'recipient_aliases',to_jsonb(aliases),'authorization_scope','approved_recipient','body',p_body);
end; $$;

-- Remove only Queue's obsolete temporary-test-number records. This never
-- touches the client's WhatsApp app, number, groups, IRAM pilot conversations,
-- business knowledge, FAQs or AI configuration.
create temporary table _old_channels on commit drop as select id,tenant_id from public.whatsapp_channels where mode='test';
create temporary table _old_conversations on commit drop as select c.id,c.tenant_id,c.customer_id from public.conversations c join _old_channels x on x.id=c.channel_id;
create temporary table _old_messages on commit drop as select m.id,m.tenant_id from public.messages m join _old_channels x on x.id=m.channel_id;
create temporary table _old_customers on commit drop as select distinct customer_id id,tenant_id from _old_conversations;
update public.conversations set attention_message_id=null where attention_message_id in(select id from _old_messages);
update public.messages
set reply_to_message_id=null
where reply_to_message_id in(select id from _old_messages)
  and id not in(select id from _old_messages);
delete from public.message_insights x using _old_messages o where x.tenant_id=o.tenant_id and x.message_id=o.id;
delete from public.blacklist_events x using _old_messages o where x.tenant_id=o.tenant_id and x.message_id=o.id;
delete from public.customer_blacklist x using _old_messages o where x.tenant_id=o.tenant_id and x.message_id=o.id;
delete from public.manual_reply_requests x using _old_conversations o where x.tenant_id=o.tenant_id and x.conversation_id=o.id;
delete from public.conversation_events x using _old_conversations o where x.tenant_id=o.tenant_id and x.conversation_id=o.id;
delete from public.assistant_selected_conversations x using _old_conversations o where x.tenant_id=o.tenant_id and x.conversation_id=o.id;
delete from public.message_jobs x using _old_messages o where x.tenant_id=o.tenant_id and x.inbound_message_id=o.id;
delete from public.ai_requests x using _old_messages o where x.tenant_id=o.tenant_id and x.request_key like 'message:'||o.id::text||'%';
delete from public.message_status_events x using _old_channels o where x.tenant_id=o.tenant_id and x.channel_id=o.id;
delete from public.whatsapp_identity_events x using _old_channels o where x.tenant_id=o.tenant_id and x.channel_id=o.id;
delete from public.whatsapp_identities x using _old_channels o where x.tenant_id=o.tenant_id and x.channel_id=o.id;
delete from public.messages x using _old_messages o where x.tenant_id=o.tenant_id and x.id=o.id;
delete from public.conversations x using _old_conversations o where x.tenant_id=o.tenant_id and x.id=o.id;
delete from public.assistant_availability_events x using _old_channels o where x.tenant_id=o.tenant_id and x.channel_id=o.id;
delete from public.whatsapp_pilot_authorizations x using _old_channels o where x.tenant_id=o.tenant_id and x.channel_id=o.id;
delete from public.whatsapp_channels x using _old_channels o where x.tenant_id=o.tenant_id and x.id=o.id;
delete from public.customers x using _old_customers o where x.tenant_id=o.tenant_id and x.id=o.id
  and not exists(select 1 from public.conversations c where c.tenant_id=x.tenant_id and c.customer_id=x.id)
  and not exists(select 1 from public.whatsapp_identities i where i.tenant_id=x.tenant_id and i.customer_id=x.id);

commit;
