begin;
alter table public.conversations add column followup_purpose text not null default 'personal' check(followup_purpose in ('personal','career')),
  add column followup_role text check(char_length(followup_role) between 1 and 120),
  add constraint career_ready_role check(followup_purpose<>'career' or followup_state<>'ready' or followup_role is not null);
alter table public.conversations drop constraint conversations_attention_reason_check;
alter table public.conversations add constraint conversations_attention_reason_check check(attention_reason in ('human_requested','complaint','manual','customer_follow_up','knowledge_gap','career_application','moderation_review'));
alter table public.conversation_events drop constraint conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check check(event_type in ('paused','resumed','manual_reply','human_requested','complaint','flagged','reply_personally','resolved','complaint_removed','customer_follow_up','knowledge_gap','career_application','moderation_review'));
alter table public.messages add column media_id text check(media_id ~ '^[0-9]{1,100}$'),
  add column moderation_state text not null default 'legacy' check(moderation_state in ('legacy','pending','clear','flagged','unavailable'));
-- Keep evidence references, never copies of images or raw moderation responses.
create table public.customer_blacklist(
  tenant_id uuid not null references public.tenants(id), customer_id uuid not null,
  message_id uuid not null, state text not null check(state in ('pending_review','kept','removed')),
  categories text[] not null, revision integer not null default 1,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),reviewed_by uuid references auth.users(id),
  primary key(tenant_id,customer_id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id),
  foreign key(tenant_id,message_id) references public.messages(tenant_id,id)
);
create table public.blacklist_events(
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null,customer_id uuid not null,
  message_id uuid not null,action text not null check(action in ('flagged','kept','removed')),actor_id uuid references auth.users(id),created_at timestamptz not null default now(),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id),foreign key(tenant_id,message_id) references public.messages(tenant_id,id)
);
alter table public.customer_blacklist enable row level security;
alter table public.blacklist_events enable row level security;
create policy blacklist_read on public.customer_blacklist for select to authenticated using(public.is_tenant_member(tenant_id));
create policy blacklist_events_read on public.blacklist_events for select to authenticated using(public.is_tenant_member(tenant_id));
revoke all on public.customer_blacklist,public.blacklist_events from public,anon,authenticated;
grant select on public.customer_blacklist,public.blacklist_events to authenticated;
grant all on public.customer_blacklist,public.blacklist_events to service_role;

create function public.ingest_moderated_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text,p_user_id text default null,p_username text default null,p_media_id text default null)
returns uuid language plpgsql set search_path='' as $$
declare ch uuid; msg uuid;
begin
  select id into ch from public.whatsapp_channels where phone_number_id=p_phone and enabled and mode='test';
  if ch is null then raise exception 'Unknown or disabled test channel'; end if;
  perform pg_advisory_xact_lock(hashtextextended('identity:'||ch::text,0));
  select id into msg from public.messages where channel_id=ch and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  msg:=public.ingest_whatsapp_identity_message(p_phone,p_provider_id,p_from,p_name,p_occurred,p_type,p_body,p_user_id,p_username);
  update public.messages set media_id=p_media_id,moderation_state='pending' where id=msg;
  return msg;
end; $$;
revoke all on function public.ingest_moderated_message(text,text,text,text,timestamptz,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ingest_moderated_message(text,text,text,text,timestamptz,text,text,text,text,text) to service_role;

-- The lease and original inbound message determine the tenant and customer, never API-supplied IDs.
create function public.finish_content_check(p_job uuid,p_lease uuid,p_state text,p_categories text[])
returns boolean language plpgsql set search_path='' as $$
declare j public.message_jobs; m public.messages; c public.conversations;
begin
  if p_state is null or p_state not in ('clear','flagged','unavailable') or p_categories is null
    or not(p_categories <@ array['sexual','sexual/minors','harassment','harassment/threatening','hate','hate/threatening'])
    or (p_state='flagged')<>(cardinality(p_categories)>0) then raise exception 'Invalid moderation result'; end if;
  select c0.* into c from public.message_jobs j0 join public.messages m0 on m0.id=j0.inbound_message_id and m0.tenant_id=j0.tenant_id
    join public.conversations c0 on c0.id=m0.conversation_id and c0.tenant_id=m0.tenant_id where j0.id=p_job;
  if c.id is null then raise exception 'Invalid job'; end if;
  perform pg_advisory_xact_lock(hashtextextended('blacklist:'||c.tenant_id::text||':'||c.customer_id::text,0));
  select * into j from public.message_jobs where id=p_job for update;
  if j.state<>'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease'; end if;
  select * into m from public.messages where id=j.inbound_message_id and tenant_id=j.tenant_id;
  if exists(select 1 from public.customer_blacklist where tenant_id=c.tenant_id and customer_id=c.customer_id and state<>'removed') then
    update public.message_jobs set state='skipped',error_code='customer_blacklisted' where id=j.id;return false;
  end if;
  if j.automation_epoch<>(select automation_epoch from public.conversations where id=c.id) then
    update public.message_jobs set state='skipped',error_code='content_check_stale' where id=j.id;return false;
  end if;
  -- Reviewed old messages can never re-block somebody after an admin removes a block.
  if m.moderation_state='clear' then return true; end if;
  if m.moderation_state in ('flagged','unavailable') then
    update public.message_jobs set state='skipped',error_code='content_previously_reviewed' where id=j.id;return false;
  end if;
  update public.messages set moderation_state=p_state where id=m.id and tenant_id=j.tenant_id;
  if p_state='clear' then return true; end if;
  if p_state='flagged' then
    insert into public.customer_blacklist(tenant_id,customer_id,message_id,state,categories) values(c.tenant_id,c.customer_id,m.id,'pending_review',p_categories)
      on conflict(tenant_id,customer_id) do update set message_id=excluded.message_id,state='pending_review',categories=excluded.categories,
        revision=public.customer_blacklist.revision+1,updated_at=now(),reviewed_by=null;
    insert into public.blacklist_events(tenant_id,customer_id,message_id,action) values(c.tenant_id,c.customer_id,m.id,'flagged');
    -- Invalidate queued AI work while retaining the original auto/human setting for unblocking.
    update public.conversations set automation_epoch=automation_epoch+1 where tenant_id=c.tenant_id and customer_id=c.customer_id;
  else
    update public.conversations set automation_mode='human',automation_epoch=automation_epoch+1,attention_state='waiting',
      attention_reason='moderation_review',attention_summary='The content check was unavailable. No abuse verdict was made. Review this message before returning the conversation to the assistant.',
      attention_message_id=m.id,attention_since=coalesce(attention_since,now()),resolved_at=null where id=c.id and tenant_id=c.tenant_id;
    insert into public.conversation_events(tenant_id,conversation_id,event_type) values(c.tenant_id,c.id,'moderation_review');
  end if;
  update public.message_jobs set state='skipped',error_code=case when p_state='flagged' then 'customer_blacklisted' else 'moderation_unavailable' end where id=j.id;
  return false;
end; $$;
revoke all on function public.finish_content_check(uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.finish_content_check(uuid,uuid,text,text[]) to service_role;

create function public.review_blacklist(p_tenant uuid,p_customer uuid,p_action text,p_revision integer)
returns void language plpgsql security definer set search_path='' as $$
declare b public.customer_blacklist;
begin
  if not public.is_tenant_member(p_tenant,array['owner','admin']) then raise exception 'Blacklist access denied'; end if;
  if p_action is null or p_action not in ('kept','removed') then raise exception 'Invalid review action'; end if;
  perform pg_advisory_xact_lock(hashtextextended('blacklist:'||p_tenant::text||':'||p_customer::text,0));
  select * into b from public.customer_blacklist where tenant_id=p_tenant and customer_id=p_customer for update;
  if b.customer_id is null or b.revision is distinct from p_revision or b.state='removed' then raise exception 'Blacklist changed; refresh first'; end if;
  update public.customer_blacklist set state=p_action,revision=revision+1,updated_at=now(),reviewed_by=auth.uid() where tenant_id=p_tenant and customer_id=p_customer;
  insert into public.blacklist_events(tenant_id,customer_id,message_id,action,actor_id) values(p_tenant,p_customer,b.message_id,p_action,auth.uid());
  update public.conversations set automation_epoch=automation_epoch+1 where tenant_id=p_tenant and customer_id=p_customer;
  -- Never replay messages accumulated during a block, even after removal.
  update public.message_jobs j set state='skipped',error_code='blacklist_reviewed' from public.messages m,public.conversations c
    where j.inbound_message_id=m.id and j.tenant_id=p_tenant and m.conversation_id=c.id and c.tenant_id=p_tenant and c.customer_id=p_customer and j.state='pending';
end; $$;
revoke all on function public.review_blacklist(uuid,uuid,text,integer) from public,anon;
grant execute on function public.review_blacklist(uuid,uuid,text,integer) to authenticated;

create or replace function public.prepare_followup_reply(p_job uuid,p_lease uuid,p_body text,p_action text,p_sources jsonb,p_reason text,p_summary text default null,p_contact jsonb default null)
returns jsonb language plpgsql set search_path='' as $$
declare j public.message_jobs; m public.messages; c public.conversations; prepared jsonb;
  contact_state text; contact_name text; contact_phone text; label text; keep_issue boolean; purpose text; desired_role text;
begin
  if p_contact is null then
    return public.prepare_inbox_reply(p_job,p_lease,p_body,p_action,p_sources,p_reason,p_summary);
  end if;
  purpose:=coalesce(p_contact->>'purpose','personal');desired_role:=nullif(btrim(p_contact->>'role'),'');
  contact_state:=p_contact->>'state';contact_name:=nullif(btrim(p_contact->>'name'),'');contact_phone:=nullif(p_contact->>'phone','');
  if jsonb_typeof(p_contact)<>'object' or contact_state is null or contact_state not in ('collecting','ready','declined')
    or (contact_name is not null and char_length(contact_name) not between 2 and 100)
    or (contact_phone is not null and contact_phone !~ '^[1-9][0-9]{6,14}$')
    or (contact_state='ready' and (contact_name is null or contact_phone is null))
    or (contact_state='collecting' and p_action is distinct from 'clarify')
    or (contact_state in ('ready','declined') and p_action is distinct from 'handoff')
    or purpose not in ('personal','career') or (desired_role is not null and char_length(desired_role)>120)
    or (purpose='career' and (p_reason is distinct from 'career_application' or (contact_state='ready' and desired_role is null)))
    or (purpose='personal' and p_reason='career_application')
    or p_reason is null or p_reason not in ('human_requested','complaint','missing_business_information','career_application')
    or p_sources is distinct from '[]'::jsonb or char_length(p_summary)>500 then
    raise exception 'Invalid follow-up details';
  end if;
  -- Same lock order and eligibility gates as every automatic reply, before any contact write.
  select * into j from public.message_jobs where id=p_job for update;
  select * into m from public.messages where id=j.inbound_message_id and tenant_id=j.tenant_id;
  select * into c from public.conversations where id=m.conversation_id and tenant_id=j.tenant_id for update;
  prepared:=public.prepare_ai_reply(p_job,p_lease,p_body,p_action,p_sources);
  if prepared is null then return null; end if;
  label:=case when p_reason='missing_business_information' then 'knowledge_gap' else p_reason end;
  -- A complaint or human request outranks an older unanswered-question review.
  keep_issue:=c.followup_state='collecting' and (c.attention_reason='complaint' or c.attention_reason=label or (c.attention_reason='human_requested' and label='knowledge_gap'));
  if keep_issue then label:=c.attention_reason; end if;
  update public.conversations set
    followup_purpose=purpose,followup_role=desired_role,followup_state=contact_state,followup_name=contact_name,followup_phone=contact_phone,
    attention_state='waiting',attention_reason=label,
    attention_summary=case when keep_issue and purpose<>'career' then c.attention_summary
      else coalesce(nullif(btrim(p_summary),''),'The customer needs personal follow-up.') end,
    attention_message_id=case when keep_issue then c.attention_message_id else m.id end,
    attention_since=case when c.attention_state='waiting' then coalesce(c.attention_since,now()) else now() end,
    resolved_at=null,is_complaint=c.is_complaint or label='complaint',
    automation_epoch=automation_epoch+case when contact_state in ('ready','declined') then 1 else 0 end
    where id=c.id and tenant_id=j.tenant_id;
  if not keep_issue then
    insert into public.conversation_events(tenant_id,conversation_id,event_type) values(j.tenant_id,c.id,label);
  end if;
  return prepared;
end; $$;
revoke all on function public.prepare_followup_reply(uuid,uuid,text,text,jsonb,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_followup_reply(uuid,uuid,text,text,jsonb,text,text,jsonb) to service_role;

create or replace function public.reset_followup_on_resume() returns trigger language plpgsql set search_path='' as $$
begin
  if new.attention_state='none' and old.attention_state<>'none' then
    new.followup_purpose:='personal';new.followup_role:=null;new.followup_state:='none';new.followup_name:=null;new.followup_phone:=null;
  end if;
  if new.attention_state='resolved' and new.followup_state='collecting' then new.followup_state:='none'; end if;
  return new;
end; $$;

create or replace function public.prepare_message_reply(p_job uuid,p_lease uuid,p_body text)
returns jsonb language plpgsql set search_path = '' as $$
declare j public.message_jobs; m public.messages; c public.conversations; ch public.whatsapp_channels; recipient text; aliases text[]; outbound uuid;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state <> 'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease'; end if;
  select * into m from public.messages where id=j.inbound_message_id;
  select * into c from public.conversations where id=m.conversation_id for update;
  select * into ch from public.whatsapp_channels where id=m.channel_id;
  if m.moderation_state not in ('legacy','clear') or exists(select 1 from public.customer_blacklist where tenant_id=c.tenant_id and customer_id=c.customer_id and state<>'removed') or j.automation_epoch<>c.automation_epoch or c.automation_mode='human' or c.status<>'open' or not ch.enabled or ch.mode<>'test' or c.last_inbound_at<now()-interval '23 hours 55 minutes' then
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
  if exists(select 1 from public.customer_blacklist where tenant_id=c.tenant_id and customer_id=c.customer_id and state<>'removed') then raise exception 'Customer is blacklisted'; end if;
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
