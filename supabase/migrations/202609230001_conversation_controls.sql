begin;

-- Personal pausing is now distinct from raising an issue. All current handoff
-- paths set their attention state explicitly, so the legacy compatibility
-- trigger must no longer turn every pause into a Needs attention case.
drop trigger if exists keep_paused_conversation_visible on public.conversations;
drop function if exists public.keep_paused_conversation_visible();

create or replace function public.manage_conversation_attention(p_conversation uuid,p_action text,p_expected timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare c public.conversations; event_name text;
begin
  if p_action is null or p_action not in ('reply','pause','resolve','resume','flag','complaint','remove_complaint') or p_expected is null then raise exception 'Invalid attention action'; end if;
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
    if p_action in ('pause','resume') and c.attention_state='none'
      and c.automation_mode=(case when p_action='pause' then 'human' else 'auto' end) then return; end if;
    if p_action='resolve' and c.attention_state='resolved' and c.automation_mode='auto' then return; end if;
    if p_action='reply' and c.attention_state='in_progress' then return; end if;
    update public.conversations set
      automation_mode=case when p_action in ('resolve','resume') then 'auto' else 'human' end,
      automation_epoch=automation_epoch+1,
      attention_state=case p_action when 'pause' then 'none' when 'resume' then 'none' when 'resolve' then 'resolved' when 'reply' then 'in_progress' else 'waiting' end,
      attention_reason=case when p_action='complaint' then 'complaint' when p_action='flag' then 'manual'
        when p_action in ('pause','resume') then null else coalesce(attention_reason,'manual') end,
      attention_message_id=case when p_action in ('pause','resume','flag','complaint') then null else attention_message_id end,
      attention_summary=case when p_action='complaint' then 'You marked this conversation as a complaint.'
        when p_action='flag' then 'You marked this conversation for personal attention.'
        when p_action in ('pause','resume') then '' else attention_summary end,
      attention_since=case when p_action in ('pause','resume') then null when c.attention_state in ('none','resolved') then now() else coalesce(attention_since,now()) end,
      resolved_at=case when p_action='resolve' then now() else null end,
      is_complaint=case when p_action='complaint' then true else is_complaint end
      where id=c.id;
    event_name:=case p_action when 'reply' then 'reply_personally' when 'pause' then 'paused' when 'resolve' then 'resolved'
      when 'resume' then 'resumed' when 'complaint' then 'complaint' else 'flagged' end;
  end if;
  insert into public.conversation_events(tenant_id,conversation_id,actor_id,event_type) values(c.tenant_id,c.id,auth.uid(),event_name);
end; $$;
revoke all on function public.manage_conversation_attention(uuid,text,timestamptz) from public,anon;
grant execute on function public.manage_conversation_attention(uuid,text,timestamptz) to authenticated;

-- Keep older dashboard clients compatible without manufacturing an issue.
create or replace function public.set_conversation_mode(p_conversation uuid,p_mode text,p_expected timestamptz)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_mode is null or p_mode not in ('auto','human') then raise exception 'Invalid mode request'; end if;
  perform public.manage_conversation_attention(p_conversation,case when p_mode='human' then 'pause' else 'resume' end,p_expected);
end; $$;

commit;
