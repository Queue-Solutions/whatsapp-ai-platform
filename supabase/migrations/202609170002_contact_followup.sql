begin;
-- Personal follow-up details remain tenant-protected customer data.
alter table public.conversations
  add column followup_state text not null default 'none' check (followup_state in ('none','collecting','ready','declined')),
  add column followup_name text check (char_length(followup_name) between 2 and 100),
  add column followup_phone text check (followup_phone ~ '^[1-9][0-9]{6,14}$'),
  add constraint followup_ready_details check (followup_state<>'ready' or (followup_name is not null and followup_phone is not null));

create function public.prepare_followup_reply(p_job uuid,p_lease uuid,p_body text,p_action text,p_sources jsonb,p_reason text,p_summary text default null,p_contact jsonb default null)
returns jsonb language plpgsql set search_path='' as $$
declare j public.message_jobs; m public.messages; c public.conversations; prepared jsonb;
  contact_state text; contact_name text; contact_phone text; label text; keep_issue boolean;
begin
  if p_contact is null then
    return public.prepare_inbox_reply(p_job,p_lease,p_body,p_action,p_sources,p_reason,p_summary);
  end if;
  contact_state:=p_contact->>'state';contact_name:=nullif(btrim(p_contact->>'name'),'');contact_phone:=nullif(p_contact->>'phone','');
  if jsonb_typeof(p_contact)<>'object' or contact_state is null or contact_state not in ('collecting','ready','declined')
    or (contact_name is not null and char_length(contact_name) not between 2 and 100)
    or (contact_phone is not null and contact_phone !~ '^[1-9][0-9]{6,14}$')
    or (contact_state='ready' and (contact_name is null or contact_phone is null))
    or (contact_state='collecting' and p_action is distinct from 'clarify')
    or (contact_state in ('ready','declined') and p_action is distinct from 'handoff')
    or p_reason is null or p_reason not in ('human_requested','complaint','missing_business_information')
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
    followup_state=contact_state,followup_name=contact_name,followup_phone=contact_phone,
    attention_state='waiting',attention_reason=label,
    attention_summary=case when keep_issue then c.attention_summary
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

-- An explicit return to the assistant starts a fresh follow-up cycle.
create function public.reset_followup_on_resume() returns trigger language plpgsql set search_path='' as $$
begin
  if new.attention_state='none' and old.attention_state<>'none' then
    new.followup_state:='none';new.followup_name:=null;new.followup_phone:=null;
  end if;
  if new.attention_state='resolved' and new.followup_state='collecting' then new.followup_state:='none'; end if;
  return new;
end; $$;
create trigger reset_followup_on_resume before update of attention_state on public.conversations
  for each row execute function public.reset_followup_on_resume();
revoke all on function public.reset_followup_on_resume() from public,anon,authenticated;
commit;
