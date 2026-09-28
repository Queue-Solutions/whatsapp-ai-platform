begin;

-- Preserve the full transcript while giving AI context a durable lower bound.
alter table public.conversations add column context_reset_at timestamptz;

alter table public.conversation_events drop constraint if exists conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check check(event_type in (
  'paused','resumed','manual_reply','human_requested','complaint','flagged','reply_personally','resolved',
  'complaint_removed','customer_follow_up','knowledge_gap','career_application','moderation_review','customer_resumed',
  'agent_context_reset'
));

-- Reset is an authenticated, tenant-scoped state transition. It never deletes
-- messages or analytics. The epoch invalidates claimed work and pending jobs are
-- terminally skipped so no pre-reset message is replayed later.
create function public.reset_conversation_context(p_conversation uuid,p_expected timestamptz)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare c public.conversations; boundary timestamptz;
begin
  if p_conversation is null or p_expected is null then raise exception 'Invalid context reset'; end if;
  select * into c from public.conversations where id=p_conversation
    and public.is_tenant_member(tenant_id,array['owner','admin','agent']) for update;
  if c.id is null then raise exception 'Conversation access denied'; end if;
  if c.updated_at is distinct from p_expected then raise exception 'Conversation changed; refresh first'; end if;
  if c.status<>'open' then raise exception 'Conversation is closed'; end if;
  boundary:=clock_timestamp();
  update public.conversations set
    context_reset_at=boundary,summary=null,
    automation_mode='auto',automation_epoch=automation_epoch+1,
    attention_state='none',attention_reason=null,attention_summary='',attention_message_id=null,
    attention_since=null,resolved_at=null,is_complaint=false,
    followup_purpose='personal',followup_role=null,followup_state='none',followup_name=null,followup_phone=null
    where id=c.id and tenant_id=c.tenant_id;
  update public.message_jobs j set state='skipped',error_code='agent_context_reset',lease_token=null,leased_until=null
    from public.messages m where j.inbound_message_id=m.id and j.tenant_id=c.tenant_id
      and m.conversation_id=c.id and j.state in ('pending','processing');
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type)
    values(c.tenant_id,c.id,auth.uid(),'agent_context_reset');
  return boundary;
end; $$;
revoke all on function public.reset_conversation_context(uuid,timestamptz) from public,anon;
grant execute on function public.reset_conversation_context(uuid,timestamptz) to authenticated;

commit;
