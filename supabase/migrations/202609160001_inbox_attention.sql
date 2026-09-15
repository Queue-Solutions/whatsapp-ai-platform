begin;
alter table public.conversations
  add column attention_state text not null default 'none' check (attention_state in ('none','waiting','in_progress','resolved')),
  add column attention_reason text check (attention_reason in ('human_requested','complaint','manual','customer_follow_up')),
  add column attention_summary text not null default '' check (char_length(attention_summary)<=500),
  add column attention_since timestamptz,
  add column resolved_at timestamptz,
  add column is_complaint boolean not null default false;

-- Existing paused conversations remain visible; no customer content is changed.
update public.conversations set attention_state='waiting',attention_reason='manual',
  attention_summary='The assistant is paused. This conversation needs your review.',attention_since=updated_at
  where automation_mode='human' and status='open';
create index inbox_attention on public.conversations(tenant_id,attention_state,attention_since);
create index inbox_complaints on public.conversations(tenant_id,last_inbound_at) where is_complaint;
alter table public.conversation_events drop constraint conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check
  check(event_type in ('paused','resumed','manual_reply','human_requested','complaint','flagged','reply_personally','resolved','complaint_removed','customer_follow_up'));

create function public.manage_conversation_attention(p_conversation uuid,p_action text,p_expected timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare c public.conversations; event_name text;
begin
  if p_action is null or p_action not in ('reply','resolve','resume','flag','complaint','remove_complaint') or p_expected is null then raise exception 'Invalid attention action'; end if;
  select * into c from public.conversations where id=p_conversation
    and public.is_tenant_member(tenant_id,array['owner','admin','agent']) for update;
  if c.id is null then raise exception 'Conversation access denied'; end if;
  if c.updated_at is distinct from p_expected then raise exception 'Conversation changed; refresh first'; end if;
  if c.status<>'open' then raise exception 'Conversation is closed'; end if;
  if p_action='remove_complaint' then
    if not c.is_complaint then return; end if;
    update public.conversations set is_complaint=false,
      attention_reason=case when attention_reason='complaint' then 'manual' else attention_reason end,
      attention_summary=case when attention_reason='complaint' then 'Complaint label removed. Review or resolve this conversation.' else attention_summary end,
      automation_epoch=automation_epoch+1 where id=c.id;
    event_name:='complaint_removed';
  else
    if p_action='resume' and c.automation_mode='auto' and c.attention_state='none' then return; end if;
    if p_action='resolve' and c.attention_state='resolved' then return; end if;
    if p_action='reply' and c.attention_state='in_progress' then return; end if;
    update public.conversations set
      automation_mode=case when p_action='resume' then 'auto' else 'human' end,
      automation_epoch=automation_epoch+1,
      attention_state=case p_action when 'resume' then 'none' when 'resolve' then 'resolved' when 'reply' then 'in_progress' else 'waiting' end,
      attention_reason=case when p_action='complaint' then 'complaint' when p_action='flag' then 'manual' when p_action='resume' then null else coalesce(attention_reason,'manual') end,
      attention_summary=case when p_action='complaint' then 'You marked this conversation as a complaint.'
        when p_action='flag' then 'You marked this conversation for personal attention.'
        when p_action='resume' then '' else attention_summary end,
      attention_since=case when p_action='resume' then null when c.attention_state in ('none','resolved') then now() else coalesce(attention_since,now()) end,
      resolved_at=case when p_action='resolve' then now() else null end,
      is_complaint=case when p_action='complaint' then true else is_complaint end
      where id=c.id;
    event_name:=case p_action when 'reply' then 'reply_personally' when 'resolve' then 'resolved' when 'resume' then 'resumed' when 'complaint' then 'complaint' else 'flagged' end;
  end if;
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type) values(c.tenant_id,c.id,auth.uid(),event_name);
end; $$;
revoke all on function public.manage_conversation_attention(uuid,text,timestamptz) from public,anon;
grant execute on function public.manage_conversation_attention(uuid,text,timestamptz) to authenticated;

-- Keep old clients compatible during deployment, using the same audited transition rules.
create or replace function public.set_conversation_mode(p_conversation uuid,p_mode text,p_expected timestamptz)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_mode is null or p_mode not in ('auto','human') then raise exception 'Invalid mode request'; end if;
  perform public.manage_conversation_attention(p_conversation,case when p_mode='human' then 'flag' else 'resume' end,p_expected);
end; $$;

-- Old deployments can still hand off through prepare_ai_reply during the rollout.
create function public.keep_paused_conversation_visible() returns trigger language plpgsql set search_path='' as $$
begin
  if new.automation_mode='human' and new.attention_state='none' then
    new.attention_state:='waiting';new.attention_reason:='human_requested';
    new.attention_summary:='The assistant handed this conversation over for your attention.';
    new.attention_since:=now();new.resolved_at:=null;
  end if;
  return new;
end; $$;
create trigger keep_paused_conversation_visible before update of automation_mode on public.conversations
  for each row execute function public.keep_paused_conversation_visible();
revoke all on function public.keep_paused_conversation_visible() from public,anon,authenticated;

-- A genuinely new inbound message reopens a resolved case. Duplicate webhook events never insert twice.
create function public.reopen_attention_on_message() returns trigger language plpgsql set search_path='' as $$
declare changed uuid;
begin
  if new.direction<>'inbound' then return new; end if;
  update public.conversations set attention_state='waiting',attention_reason='customer_follow_up',
    attention_summary='The customer sent a new message after this conversation was resolved.',
    attention_since=now(),resolved_at=null,automation_epoch=automation_epoch+1
    where id=new.conversation_id and tenant_id=new.tenant_id and attention_state='resolved'
      and new.occurred_at>=date_trunc('second',resolved_at) returning id into changed;
  if changed is not null then
    insert into public.conversation_events(tenant_id,conversation_id,event_type) values(new.tenant_id,changed,'customer_follow_up');
  end if;
  return new;
end; $$;
create trigger reopen_attention_on_message after insert on public.messages for each row execute function public.reopen_attention_on_message();
revoke all on function public.reopen_attention_on_message() from public,anon,authenticated;

-- Preserve all existing source, lease, epoch, channel and service-window checks.
-- The handover and the acknowledgment send intent commit in the same transaction.
create function public.prepare_inbox_reply(p_job uuid,p_lease uuid,p_body text,p_action text,p_sources jsonb,p_reason text,p_summary text default null)
returns jsonb language plpgsql set search_path='' as $$
declare prepared jsonb; j public.message_jobs; m public.messages; label text;
begin
  if char_length(p_summary)>500 then raise exception 'Invalid attention summary'; end if;
  prepared:=public.prepare_ai_reply(p_job,p_lease,p_body,p_action,p_sources);
  if prepared is not null and p_action='handoff' then
    select * into j from public.message_jobs where id=p_job;
    select * into m from public.messages where id=j.inbound_message_id and tenant_id=j.tenant_id;
    label:=case when p_reason='complaint' then 'complaint' else 'human_requested' end;
    update public.conversations set attention_state='waiting',attention_reason=label,attention_since=now(),resolved_at=null,
      attention_summary=coalesce(nullif(btrim(p_summary),''),case when label='complaint' then 'The customer raised a complaint. Review the conversation before replying.' else 'The customer asked to speak to you personally.' end),
      is_complaint=is_complaint or label='complaint',automation_epoch=automation_epoch+1
      where id=m.conversation_id and tenant_id=j.tenant_id;
    insert into public.conversation_events(tenant_id,conversation_id,event_type) values(j.tenant_id,m.conversation_id,label);
  end if;
  return prepared;
end; $$;
revoke all on function public.prepare_inbox_reply(uuid,uuid,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.prepare_inbox_reply(uuid,uuid,text,text,jsonb,text,text) to service_role;
create or replace function public.prepare_manual_reply(p_actor uuid,p_conversation uuid,p_request uuid,p_body text,p_phone text,p_allowed text[])
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
  if c.automation_mode<>'human' or c.status<>'open' or c.attention_state='resolved' then raise exception 'Pause the assistant before replying'; end if;
  if c.last_inbound_at<now()-interval '23 hours 55 minutes' then raise exception 'Customer service window expired'; end if;
  if ch.mode is distinct from 'test' or ch.enabled is distinct from true or ch.phone_number_id is distinct from p_phone
    or p_allowed is null or not coalesce(recipient=any(p_allowed),false) then raise exception 'Test guard rejected'; end if;
  update public.conversations set attention_state='in_progress',attention_since=coalesce(attention_since,now()) where id=c.id;
  insert into public.messages(tenant_id,conversation_id,channel_id,direction,message_type,body,delivery_status,occurred_at)
    values(c.tenant_id,c.id,ch.id,'outbound','text',p_body,'sending',now()) returning id into outbound;
  insert into public.manual_reply_requests(id,tenant_id,conversation_id,actor_id,outbound_id,state)
    values(p_request,c.tenant_id,c.id,p_actor,outbound,'sending');
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type) values(c.tenant_id,c.id,p_actor,'manual_reply');
  return jsonb_build_object('state','new','reply',jsonb_build_object('outbound_id',outbound,'phone_number_id',ch.phone_number_id,'recipient',recipient,'body',p_body));
end; $$;

commit;
