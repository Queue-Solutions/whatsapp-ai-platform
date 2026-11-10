begin;

-- For an authorized pilot, the dashboard availability choice is the normal
-- operational send switch. The deployment flag remains an independent
-- emergency kill switch, and the selected-recipient checks still apply.
create or replace function public.set_assistant_availability(p_channel uuid,p_scope text,p_selected uuid[] default array[]::uuid[])
returns void language plpgsql security definer set search_path='' as $$
declare
  ch public.whatsapp_channels;chosen uuid[];approved uuid[];combined uuid[];previous uuid[];
  invalid_selection boolean;approval_count integer;pilot_sending boolean;pilot_receiving boolean;pilot_approved boolean;
begin
  if p_channel is null or p_scope is null or p_scope not in ('all','off','selected') or p_selected is null then raise exception 'Invalid assistant availability';end if;
  select * into ch from public.whatsapp_channels where id=p_channel and public.is_tenant_member(tenant_id) for update;
  if ch.id is null then raise exception 'Channel access denied';end if;
  select coalesce(array_agg(value order by value),array[]::uuid[]) into chosen from(select distinct unnest(p_selected)value)s;
  select coalesce(array_agg(conversation_id order by conversation_id) filter(where conversation_id is not null),array[]::uuid[]),count(*)
    into approved,approval_count from public.assistant_approved_recipients where tenant_id=ch.tenant_id and channel_id=ch.id;
  select coalesce(array_agg(value order by value),array[]::uuid[]) into combined from(select distinct unnest(chosen||approved)value)s;
  if p_scope='selected' and cardinality(combined)=0 and approval_count=0 then raise exception 'Approve at least one recipient';end if;
  select exists(select 1 from unnest(combined)s(conversation_id) left join public.conversations c
    on c.id=s.conversation_id and c.tenant_id=ch.tenant_id and c.channel_id=ch.id and c.status='open' where c.id is null) into invalid_selection;
  if invalid_selection then raise exception 'Invalid conversation selection';end if;
  select coalesce(array_agg(conversation_id order by conversation_id),array[]::uuid[]) into previous from public.assistant_selected_conversations where tenant_id=ch.tenant_id and channel_id=ch.id;
  if ch.mode='pilot' then
    select sending_enabled,receiving_enabled,approved_at is not null into pilot_sending,pilot_receiving,pilot_approved
      from public.whatsapp_pilot_authorizations where tenant_id=ch.tenant_id and channel_id=ch.id for update;
    if not found or (p_scope='selected' and (not pilot_receiving or not pilot_approved)) then raise exception 'Pilot authorization unavailable';end if;
  end if;
  if ch.assistant_scope=p_scope and previous=combined and (ch.mode<>'pilot' or pilot_sending=(p_scope='selected')) then return;end if;
  delete from public.assistant_selected_conversations where tenant_id=ch.tenant_id and channel_id=ch.id and not(conversation_id=any(combined));
  insert into public.assistant_selected_conversations(tenant_id,channel_id,conversation_id,selected_by)
    select ch.tenant_id,ch.id,s.conversation_id,auth.uid() from unnest(combined)s(conversation_id) on conflict(channel_id,conversation_id) do nothing;
  update public.whatsapp_channels set assistant_scope=p_scope where id=ch.id;
  update public.conversations set automation_epoch=automation_epoch+1 where tenant_id=ch.tenant_id and channel_id=ch.id and status='open';
  update public.message_jobs j set state='skipped',error_code='assistant_availability_changed' from public.messages m
    where j.inbound_message_id=m.id and j.tenant_id=ch.tenant_id and m.channel_id=ch.id and j.state='pending';
  if ch.mode='pilot' then
    update public.whatsapp_pilot_authorizations set sending_enabled=(p_scope='selected')
      where tenant_id=ch.tenant_id and channel_id=ch.id and sending_enabled is distinct from (p_scope='selected');
  end if;
  insert into public.assistant_availability_events(tenant_id,channel_id,actor_id,previous_scope,new_scope,selected_count)
    values(ch.tenant_id,ch.id,auth.uid(),ch.assistant_scope,p_scope,cardinality(combined));
end; $$;

revoke all on function public.set_assistant_availability(uuid,text,uuid[]) from public,anon;
grant execute on function public.set_assistant_availability(uuid,text,uuid[]) to authenticated;

-- Align an already-selected pilot without replaying messages that arrived while
-- the independent pilot send lock was intentionally off.
update public.message_jobs j set state='skipped',error_code='pilot_send_activation_changed',leased_until=null
from public.messages m,public.whatsapp_channels ch,public.whatsapp_pilot_authorizations p
where j.inbound_message_id=m.id and m.channel_id=ch.id and p.channel_id=ch.id and p.tenant_id=ch.tenant_id
  and ch.mode='pilot' and ch.assistant_scope='selected' and not p.sending_enabled and j.state='pending';
update public.whatsapp_pilot_authorizations p set sending_enabled=true
from public.whatsapp_channels ch
where p.channel_id=ch.id and p.tenant_id=ch.tenant_id and ch.mode='pilot' and ch.assistant_scope='selected'
  and p.approved_at is not null and p.receiving_enabled and not p.sending_enabled;

commit;
