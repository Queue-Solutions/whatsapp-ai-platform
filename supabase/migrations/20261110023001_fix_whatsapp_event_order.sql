begin;

-- WhatsApp may retry an older webhook after a newer turn has already arrived.
-- Keep receipt time for auditing, but use the provider event time for customer chronology.
create index if not exists message_event_history
  on public.messages(tenant_id,conversation_id,occurred_at desc,created_at desc,id desc);

create or replace function public.message_history_before(p_tenant uuid,p_message uuid,p_limit integer default 16)
returns table(id uuid,body text,direction text,occurred_at timestamptz,created_at timestamptz)
language sql stable security invoker set search_path='' as $$
  select h.id,h.body,h.direction,h.occurred_at,h.created_at
  from public.messages current
  join public.messages h
    on h.tenant_id=current.tenant_id and h.conversation_id=current.conversation_id
  where current.tenant_id=p_tenant and current.id=p_message
    and h.delivery_status in ('received','sent','delivered','read')
    and (h.occurred_at,h.created_at,h.id)<(current.occurred_at,current.created_at,current.id)
  order by h.occurred_at desc,h.created_at desc,h.id desc
  limit greatest(0,least(coalesce(p_limit,16),100));
$$;
revoke all on function public.message_history_before(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.message_history_before(uuid,uuid,integer) to service_role;

-- Do not let a webhook that arrived late supersede a chronologically newer turn.
update public.message_jobs j
set state='skipped',error_code='superseded_by_newer_inbound',leased_until=null
from public.messages m
where j.inbound_message_id=m.id and j.state='pending'
  and exists(
    select 1 from public.messages newer
    where newer.tenant_id=m.tenant_id and newer.conversation_id=m.conversation_id
      and newer.direction='inbound'
      and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id)
  );

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
          and newer.direction='inbound'
          and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id));
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
    order by m.occurred_at,m.created_at,m.id for update of j skip locked limit 1;
  return query update public.message_jobs set state='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes' where id=job_id returning *;
end; $$;

create or replace function public.prepare_message_reply(p_job uuid,p_lease uuid,p_body text)
returns jsonb language plpgsql set search_path='' as $$
declare j public.message_jobs;m public.messages;c public.conversations;ch public.whatsapp_channels;recipient text;aliases text[];outbound uuid;availability_denied boolean;superseded boolean;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease';end if;
  select * into m from public.messages where id=j.inbound_message_id;select * into c from public.conversations where id=m.conversation_id for update;select * into ch from public.whatsapp_channels where id=m.channel_id;
  availability_denied:=ch.assistant_scope='off' or(ch.assistant_scope='selected' and not exists(select 1 from public.assistant_selected_conversations s where s.tenant_id=ch.tenant_id and s.channel_id=ch.id and s.conversation_id=c.id));
  superseded:=exists(select 1 from public.messages newer where newer.tenant_id=m.tenant_id and newer.conversation_id=m.conversation_id and newer.direction='inbound' and(newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id));
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

revoke all on function public.claim_message_job(text),public.prepare_message_reply(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_message_job(text),public.prepare_message_reply(uuid,uuid,text) to service_role;

commit;
