begin;

-- Coexistence sends a separate event when a person replies from the WhatsApp
-- Business app. Store it as outbound history, never as a customer turn or AI job.
alter table public.conversation_events drop constraint if exists conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check check(event_type in (
  'paused','resumed','manual_reply','human_requested','complaint','flagged','reply_personally','resolved',
  'complaint_removed','customer_follow_up','knowledge_gap','career_application','moderation_review','customer_resumed',
  'agent_context_reset','human_app_reply'
));

create function public.ingest_whatsapp_app_echo(
  p_phone text,p_provider_id text,p_to text,p_occurred timestamptz,p_type text,p_body text,
  p_user_id text default null,p_media_id text default null
) returns uuid language plpgsql set search_path='' as $$
declare
  ch public.whatsapp_channels;
  recipient text;
  aliases text[];
  cust uuid;
  conv uuid;
  msg uuid;
begin
  select * into ch from public.whatsapp_channels
    where phone_number_id=p_phone and public.whatsapp_channel_active(id);
  if ch.id is null then raise exception 'Unknown or disabled WhatsApp channel'; end if;
  if p_provider_id is null or char_length(p_provider_id) not between 1 and 512
    or p_type is null or char_length(p_type) not between 1 and 64
    or (p_body is not null and char_length(p_body)>16384)
    or (p_media_id is not null and p_media_id!~'^[0-9]{1,100}$')
    or p_occurred>now()+interval '5 minutes' then raise exception 'Invalid app echo'; end if;

  recipient:=coalesce(public.normalize_egypt_mobile(p_to),p_to);
  if recipient is null or recipient!~'^([0-9]{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$'
    or (p_user_id is not null and p_user_id!~'^[A-Z]{2}\.[A-Za-z0-9]{1,128}$') then
    raise exception 'Invalid recipient identity';
  end if;
  aliases:=array_remove(array[recipient,p_user_id],null);

  perform pg_advisory_xact_lock(hashtextextended('app-echo:'||ch.id::text,0));
  select id into msg from public.messages where channel_id=ch.id and provider_message_id=p_provider_id;
  if msg is not null then return msg; end if;
  if not public.whatsapp_pilot_recipient_allowed(ch.id,recipient,aliases) then return null; end if;

  select i.customer_id into cust from public.whatsapp_identities i
    where i.tenant_id=ch.tenant_id and i.channel_id=ch.id and i.active and i.identifier=any(aliases)
    order by case when i.identifier=recipient then 0 else 1 end limit 1;
  if cust is null and recipient~'^[0-9]' then
    select id into cust from public.customers
      where tenant_id=ch.tenant_id and public.normalize_egypt_mobile(whatsapp_id)=public.normalize_egypt_mobile(recipient)
      limit 1;
  end if;
  if cust is null then return null; end if;

  select id into conv from public.conversations
    where tenant_id=ch.tenant_id and channel_id=ch.id and customer_id=cust and status='open'
    order by last_inbound_at desc limit 1 for update;
  if conv is null then return null; end if;

  insert into public.messages(tenant_id,conversation_id,channel_id,direction,provider_message_id,message_type,body,media_id,delivery_status,occurred_at)
    values(ch.tenant_id,conv,ch.id,'outbound',p_provider_id,p_type,p_body,p_media_id,'sent',p_occurred)
    returning id into msg;

  -- A human reply wins the race. Pause automation without manufacturing an
  -- attention/complaint badge, and invalidate only unsent AI work.
  update public.conversations set automation_mode='human',automation_epoch=automation_epoch+1,
    attention_state='none',attention_reason=null,attention_summary='',attention_message_id=null,
    attention_since=null,resolved_at=null
    where tenant_id=ch.tenant_id and id=conv;
  update public.message_jobs j set state='skipped',error_code='human_app_reply',lease_token=null,leased_until=null
    from public.messages inbound
    where j.tenant_id=ch.tenant_id and j.inbound_message_id=inbound.id and inbound.conversation_id=conv
      and j.state in ('pending','processing');
  insert into public.conversation_events(tenant_id,conversation_id,event_type)
    values(ch.tenant_id,conv,'human_app_reply');
  return msg;
end; $$;

revoke all on function public.ingest_whatsapp_app_echo(text,text,text,timestamptz,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.ingest_whatsapp_app_echo(text,text,text,timestamptz,text,text,text,text)
  to service_role;

commit;
