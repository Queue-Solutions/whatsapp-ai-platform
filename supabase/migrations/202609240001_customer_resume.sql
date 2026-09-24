begin;

-- Marks the one inbound command that is allowed to reopen an actively handed-off
-- conversation. The marker is stamped server-side from an exact whole-message
-- command and cannot be supplied by a browser or webhook field.
alter table public.message_jobs add column customer_resume boolean not null default false;

alter table public.conversation_events drop constraint conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check check(event_type in (
  'paused','resumed','manual_reply','human_requested','complaint','flagged','reply_personally','resolved',
  'complaint_removed','customer_follow_up','knowledge_gap','career_application','moderation_review','customer_resumed'
));

-- Keep ingestion, command handling, epoch invalidation and the audit event in one
-- transaction. Only the exact standalone words AI or Cancel are commands.
create or replace function public.ingest_moderated_message(p_phone text,p_provider_id text,p_from text,p_name text,p_occurred timestamptz,p_type text,p_body text,p_user_id text default null,p_username text default null,p_media_id text default null)
returns uuid language plpgsql set search_path='' as $$
declare ch uuid; msg uuid; conv uuid; c public.conversations; next_epoch bigint; command text;
begin
  select id into ch from public.whatsapp_channels where phone_number_id=p_phone and enabled and mode='test';
  if ch is null then raise exception 'Unknown or disabled test channel'; end if;
  perform pg_advisory_xact_lock(hashtextextended('identity:'||ch::text,0));
  select id into msg from public.messages where channel_id=ch and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  msg:=public.ingest_whatsapp_identity_message(p_phone,p_provider_id,p_from,p_name,p_occurred,p_type,p_body,p_user_id,p_username);
  update public.messages set media_id=p_media_id,moderation_state='pending' where id=msg;

  command:=lower(regexp_replace(btrim(coalesce(p_body,'')),'[[:space:][:punct:]]','','g'));
  if p_type='text' and command in ('ai','cancel') then
    select conversation_id into conv from public.messages where id=msg;
    select * into c from public.conversations where id=conv for update;
    if c.automation_mode='human' and c.status='open'
      and (c.attention_state in ('waiting','in_progress') or c.followup_state<>'none' or c.is_complaint) then
      update public.conversations set
        automation_mode='auto',automation_epoch=automation_epoch+1,
        attention_state='resolved',attention_summary='The customer cancelled personal follow-up and returned to the AI assistant.',
        resolved_at=now(),is_complaint=false,
        followup_purpose='personal',followup_role=null,followup_state='none',followup_name=null,followup_phone=null
        where id=c.id and tenant_id=c.tenant_id returning automation_epoch into next_epoch;
      -- Never replay messages accumulated while the assistant was paused.
      update public.message_jobs j set state='skipped',error_code='customer_resumed'
        from public.messages queued where j.inbound_message_id=queued.id and j.tenant_id=c.tenant_id
          and queued.conversation_id=c.id and queued.id<>msg and j.state='pending';
      update public.message_jobs set automation_epoch=next_epoch,customer_resume=true where inbound_message_id=msg and tenant_id=c.tenant_id;
      insert into public.conversation_events(tenant_id,conversation_id,event_type) values(c.tenant_id,c.id,'customer_resumed');
    end if;
  end if;
  return msg;
end; $$;
revoke all on function public.ingest_moderated_message(text,text,text,text,timestamptz,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ingest_moderated_message(text,text,text,text,timestamptz,text,text,text,text,text) to service_role;

commit;
