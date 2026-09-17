begin;
-- Additive, content-preserving migration. The original unanswered message remains the source of truth.
alter table public.conversations drop constraint conversations_attention_reason_check;
alter table public.conversations add constraint conversations_attention_reason_check
  check (attention_reason in ('human_requested','complaint','manual','customer_follow_up','knowledge_gap'));
alter table public.conversations add column attention_message_id uuid,
  add constraint conversation_attention_message_fk foreign key (tenant_id,attention_message_id) references public.messages(tenant_id,id);
alter table public.conversation_events drop constraint conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check
  check(event_type in ('paused','resumed','manual_reply','human_requested','complaint','flagged','reply_personally','resolved','complaint_removed','customer_follow_up','knowledge_gap'));

create or replace function public.manage_conversation_attention(p_conversation uuid,p_action text,p_expected timestamptz)
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
      automation_mode=case when p_action='resume' then 'auto' when p_action='resolve' and c.attention_reason='knowledge_gap' then c.automation_mode else 'human' end,
      automation_epoch=automation_epoch+1,
      attention_state=case p_action when 'resume' then 'none' when 'resolve' then 'resolved' when 'reply' then 'in_progress' else 'waiting' end,
      attention_reason=case when p_action='complaint' then 'complaint' when p_action='flag' then 'manual' when p_action='resume' then null else coalesce(attention_reason,'manual') end,
      attention_message_id=case when p_action in ('resume','flag','complaint') then null else attention_message_id end,
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


-- Resolved knowledge reviews with the assistant on reopen only for a new knowledge gap.
create or replace function public.reopen_attention_on_message() returns trigger language plpgsql set search_path='' as $$
declare changed uuid;
begin
  if new.direction<>'inbound' then return new; end if;
  update public.conversations set attention_state='waiting',attention_reason='customer_follow_up',
    attention_summary='The customer sent a new message after this conversation was resolved.',
    attention_since=now(),resolved_at=null,automation_epoch=automation_epoch+1
    where id=new.conversation_id and tenant_id=new.tenant_id and attention_state='resolved' and automation_mode='human'
      and new.occurred_at>=date_trunc('second',resolved_at) returning id into changed;
  if changed is not null then
    insert into public.conversation_events(tenant_id,conversation_id,event_type) values(new.tenant_id,changed,'customer_follow_up');
  end if;
  return new;
end; $$;

create or replace function public.prepare_inbox_reply(p_job uuid,p_lease uuid,p_body text,p_action text,p_sources jsonb,p_reason text,p_summary text default null)
returns jsonb language plpgsql set search_path='' as $$
declare prepared jsonb; j public.message_jobs; m public.messages; label text; changed uuid;
begin
  if char_length(p_summary)>500 then raise exception 'Invalid attention summary'; end if;
  prepared:=public.prepare_ai_reply(p_job,p_lease,p_body,p_action,p_sources);
  if prepared is not null and p_action='handoff' then
    select * into j from public.message_jobs where id=p_job;
    select * into m from public.messages where id=j.inbound_message_id and tenant_id=j.tenant_id;
    label:=case when p_reason='complaint' then 'complaint' else 'human_requested' end;
    update public.conversations set attention_state='waiting',attention_reason=label,attention_since=now(),resolved_at=null,
      attention_message_id=null,
      attention_summary=coalesce(nullif(btrim(p_summary),''),case when label='complaint' then 'The customer raised a complaint. Review the conversation before replying.' else 'The customer asked to speak to you personally.' end),
      is_complaint=is_complaint or label='complaint',automation_epoch=automation_epoch+1
      where id=m.conversation_id and tenant_id=j.tenant_id;
    insert into public.conversation_events(tenant_id,conversation_id,event_type) values(j.tenant_id,m.conversation_id,label);
  end if;
  if prepared is not null and p_action='unavailable' and p_reason='missing_business_information' then
    select * into j from public.message_jobs where id=p_job;
    select * into m from public.messages where id=j.inbound_message_id and tenant_id=j.tenant_id;
    -- Preserve higher-priority personal attention, and do not invalidate other automatic jobs.
    update public.conversations set attention_state='waiting',attention_reason='knowledge_gap',
      attention_summary=coalesce(nullif(btrim(p_summary),''),'The available business information did not confirm an answer. Review the question and add an approved answer.'),
      attention_message_id=m.id,
      attention_since=case when attention_state='waiting' then coalesce(attention_since,now()) else now() end,
      resolved_at=null
      where id=m.conversation_id and tenant_id=j.tenant_id and automation_mode='auto'
        and (attention_state in ('none','resolved') or (attention_state='waiting' and attention_reason='knowledge_gap'))
      returning id into changed;
    if changed is not null then
      insert into public.conversation_events(tenant_id,conversation_id,event_type) values(j.tenant_id,changed,'knowledge_gap');
    end if;
  end if;
  return prepared;
end; $$;
revoke all on function public.prepare_inbox_reply(uuid,uuid,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.prepare_inbox_reply(uuid,uuid,text,text,jsonb,text,text) to service_role;

commit;
