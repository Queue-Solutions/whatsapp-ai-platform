begin;

-- Recommendations are derived from bounded message insights rather than
-- stored as mutable rows. A tenant-scoped cutoff clears the current view while
-- preserving the underlying analytics/audit data and lets future activity
-- produce fresh recommendations.
create table public.ai_recommendation_resets (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  reset_at timestamptz not null default now(),
  reset_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.ai_recommendation_resets enable row level security;
revoke all on public.ai_recommendation_resets from public,anon,authenticated;
grant select on public.ai_recommendation_resets to authenticated;
create policy tenant_recommendation_reset_read on public.ai_recommendation_resets for select to authenticated
  using(public.is_tenant_member(tenant_id));

create function public.get_ai_recommendations(p_tenant uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; cutoff timestamptz;
begin
  if not public.is_tenant_member(p_tenant) then raise exception 'Recommendation access denied'; end if;
  select reset_at into cutoff from public.ai_recommendation_resets where tenant_id=p_tenant;
  cutoff:=coalesce(cutoff,'-infinity'::timestamptz);

  with topic_stats as (
    select lower(regexp_replace(btrim(i.topic),'\s+',' ','g')) topic_key,min(i.topic) topic,count(*) mentions,
      count(distinct c.customer_id) customers,max(m.occurred_at) last_seen,
      bool_or(i.is_knowledge_gap) has_gap
    from public.message_insights i join public.messages m on m.tenant_id=i.tenant_id and m.id=i.message_id
      join public.conversations c on c.tenant_id=i.tenant_id and c.id=i.conversation_id
    where i.tenant_id=p_tenant and i.topic is not null and char_length(btrim(i.topic))>=8
      and coalesce(i.intent,'') not in ('greeting','thanks','contact_details','human_followup','complaint','unrelated','ambiguous','career')
      and m.occurred_at>cutoff
    group by 1
  ), faq_recommendations as (
    select 'faq_gap'::text kind,t.topic,t.mentions,t.customers,t.last_seen,
      case when t.has_gap then 'Customers asked about this topic and the assistant could not confirm an answer.'
        else 'Customers repeatedly asked about this topic, but no matching published FAQ was found.' end reason
    from topic_stats t where (t.mentions>=2 or t.has_gap) and not exists(
      select 1 from public.faqs f where f.tenant_id=p_tenant and f.is_published and f.deleted_at is null and btrim(f.question)<>''
        and (lower(regexp_replace(btrim(f.question),'\s+',' ','g'))=t.topic_key
          or position(t.topic_key in lower(regexp_replace(btrim(f.question),'\s+',' ','g')))>0
          or position(lower(regexp_replace(btrim(f.question),'\s+',' ','g')) in t.topic_key)>0)
    )
  ), complaint_stats as (
    select lower(regexp_replace(btrim(i.topic),'\s+',' ','g')) topic_key,min(i.topic) topic,count(*) mentions,
      count(distinct c.customer_id) customers,max(m.occurred_at) last_seen
    from public.message_insights i join public.messages m on m.tenant_id=i.tenant_id and m.id=i.message_id
      join public.conversations c on c.tenant_id=i.tenant_id and c.id=i.conversation_id
    where i.tenant_id=p_tenant and i.intent='complaint' and i.topic is not null and m.occurred_at>cutoff
    group by 1 having count(*)>=2
  ), complaint_recommendations as (
    select 'complaint_theme'::text kind,topic,mentions,customers,last_seen,
      'Several customers raised a complaint about this topic. Review the related conversations and the underlying process.'::text reason
    from complaint_stats
  ), recommendations as (
    select * from faq_recommendations union all select * from complaint_recommendations
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind',kind,'topic',topic,'mentions',mentions,'customers',customers,'lastSeen',last_seen,'reason',reason
  ) order by mentions desc,last_seen desc),'[]'::jsonb) into result from recommendations;
  return result;
end; $$;
revoke all on function public.get_ai_recommendations(uuid) from public,anon;
grant execute on function public.get_ai_recommendations(uuid) to authenticated;

create function public.reset_ai_recommendations(p_tenant uuid)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare reset_time timestamptz:=clock_timestamp(); actor uuid:=auth.uid();
begin
  if actor is null or not public.is_tenant_member(p_tenant,array['owner','admin']) then
    raise exception 'Recommendation reset access denied';
  end if;
  insert into public.ai_recommendation_resets(tenant_id,reset_at,reset_by,updated_at)
    values(p_tenant,reset_time,actor,reset_time)
    on conflict(tenant_id) do update set reset_at=excluded.reset_at,reset_by=excluded.reset_by,updated_at=excluded.updated_at;
  return reset_time;
end; $$;
revoke all on function public.reset_ai_recommendations(uuid) from public,anon;
grant execute on function public.reset_ai_recommendations(uuid) to authenticated;

commit;
