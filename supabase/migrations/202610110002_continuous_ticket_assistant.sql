begin;

-- Customer messages are always ordinary inbound turns. The retired standalone
-- Cancel/الغاء command no longer clears tickets, complaint state or contact data.
create or replace function public.ingest_moderated_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text,p_user_id text default null,p_username text default null,p_media_id text default null)
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

-- Contact collection creates and updates the ticket, but does not hand the
-- conversation away from the assistant. The public action remains `handoff`
-- for validation and analytics; the lower-level send guard receives `clarify`
-- so it does not switch automation_mode to human.
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
  select * into j from public.message_jobs where id=p_job for update;
  select * into m from public.messages where id=j.inbound_message_id and tenant_id=j.tenant_id;
  select * into c from public.conversations where id=m.conversation_id and tenant_id=j.tenant_id for update;
  prepared:=public.prepare_ai_reply(p_job,p_lease,p_body,case when p_action='handoff' then 'clarify' else p_action end,p_sources);
  if prepared is null then return null; end if;
  label:=case when p_reason='missing_business_information' then 'knowledge_gap' else p_reason end;
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

-- Existing tickets created by the old behavior should gain the same continuous
-- assistant behavior without replaying messages that accumulated while paused.
update public.message_jobs j set state='skipped',error_code='ticket_assistant_continued'
from public.messages m,public.conversations c
where j.inbound_message_id=m.id and m.conversation_id=c.id and j.tenant_id=c.tenant_id
  and c.automation_mode='human' and c.attention_state='waiting' and c.followup_state in ('ready','declined')
  and j.state='pending';

update public.conversations set automation_mode='auto',automation_epoch=automation_epoch+1
where automation_mode='human' and attention_state='waiting' and followup_state in ('ready','declined');

-- Remove the command-only queue marker from the live schema. Historical audit
-- events and migrations remain untouched so no chat or audit history is lost.
alter table public.message_jobs drop column if exists customer_resume;

commit;
