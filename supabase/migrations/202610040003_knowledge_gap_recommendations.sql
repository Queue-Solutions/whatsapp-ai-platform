begin;

-- A FAQ opportunity is evidence of an actual unanswered turn, not merely a
-- repeated topic. `is_knowledge_gap` is written only when the bounded reply
-- decision cannot confirm an answer and starts personal follow-up.
create or replace function public.get_ai_recommendations(p_tenant uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; cutoff timestamptz;
begin
  if not public.is_tenant_member(p_tenant) then raise exception 'Recommendation access denied'; end if;
  select reset_at into cutoff from public.ai_recommendation_resets where tenant_id=p_tenant;
  cutoff:=coalesce(cutoff,'-infinity'::timestamptz);

  with gap_stats as (
    select lower(regexp_replace(coalesce(nullif(btrim(i.topic),''),nullif(btrim(i.summary),'')),'\s+',' ','g')) topic_key,
      min(coalesce(nullif(btrim(i.topic),''),nullif(btrim(i.summary),''))) topic,
      count(*) mentions,count(distinct c.customer_id) customers,max(m.occurred_at) last_seen
    from public.message_insights i join public.messages m on m.tenant_id=i.tenant_id and m.id=i.message_id
      join public.conversations c on c.tenant_id=i.tenant_id and c.id=i.conversation_id
    where i.tenant_id=p_tenant and i.is_knowledge_gap and m.occurred_at>cutoff
      and coalesce(nullif(btrim(i.topic),''),nullif(btrim(i.summary),'')) is not null
    group by 1
  ), faq_recommendations as (
    select 'faq_gap'::text kind,t.topic,t.mentions,t.customers,t.last_seen,
      'The assistant could not confirm an answer and started personal follow-up for this request.'::text reason
    from gap_stats t where not exists(
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

commit;
