begin;

-- Store bounded classification metadata for reporting. This deliberately keeps
-- no copy of the customer message or provider response.
create table public.message_insights (
  tenant_id uuid not null references public.tenants(id),
  message_id uuid not null,
  conversation_id uuid not null,
  intent text,
  topic text check (topic is null or char_length(topic) between 1 and 500),
  language text check (language is null or language in ('ar','en')),
  risk text not null default 'none' check (risk in ('none','spam_or_fraud')),
  summary text check (summary is null or char_length(summary) <= 240),
  is_knowledge_gap boolean not null default false,
  classified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,message_id),
  foreign key (tenant_id,message_id) references public.messages(tenant_id,id),
  foreign key (tenant_id,conversation_id) references public.conversations(tenant_id,id)
);
create index message_insights_reporting on public.message_insights(tenant_id,classified_at,intent,risk);
alter table public.message_insights enable row level security;
revoke all on public.message_insights from public,anon,authenticated;
grant all on public.message_insights to service_role;
grant select on public.message_insights to authenticated;
create policy tenant_insights_read on public.message_insights for select to authenticated
  using(public.is_tenant_member(tenant_id));

create function public.capture_message_insight() returns trigger language plpgsql set search_path='' as $$
declare insight_message uuid; insight_conversation uuid; raw_id text;
begin
  if new.state <> 'completed' or new.decision is null or new.request_key !~ '^message:[0-9a-fA-F-]{36}' then return new; end if;
  raw_id:=substring(new.request_key from '^message:([0-9a-fA-F-]{36})');
  begin insight_message:=raw_id::uuid; exception when others then return new; end;
  select conversation_id into insight_conversation from public.messages where tenant_id=new.tenant_id and id=insight_message;
  if insight_conversation is null then return new; end if;
  if new.decision->>'kind'='intent_classification' then
    insert into public.message_insights(tenant_id,message_id,conversation_id,intent,topic,language,risk,summary,classified_at,updated_at)
      values(new.tenant_id,insight_message,insight_conversation,nullif(new.decision->>'intent',''),coalesce(nullif(btrim(new.decision->>'analyticsTopic'),''),nullif(btrim(new.decision->>'normalizedQuery'),'')),
        nullif(new.decision->>'language',''),coalesce(nullif(new.decision->>'risk',''),'none'),nullif(btrim(new.decision->>'summary'),''),
        coalesce(new.completed_at,now()),now())
      on conflict(tenant_id,message_id) do update set intent=excluded.intent,topic=excluded.topic,language=excluded.language,
        risk=excluded.risk,summary=coalesce(excluded.summary,public.message_insights.summary),classified_at=excluded.classified_at,updated_at=now();
  elsif new.decision ? 'reason' then
    insert into public.message_insights(tenant_id,message_id,conversation_id,summary,is_knowledge_gap,classified_at,updated_at)
      values(new.tenant_id,insight_message,insight_conversation,nullif(btrim(new.decision->>'attentionSummary'),''),
        new.decision->>'reason'='missing_business_information',coalesce(new.completed_at,now()),now())
      on conflict(tenant_id,message_id) do update set
        summary=coalesce(excluded.summary,public.message_insights.summary),
        is_knowledge_gap=public.message_insights.is_knowledge_gap or excluded.is_knowledge_gap,updated_at=now();
  end if;
  return new;
end; $$;
revoke all on function public.capture_message_insight() from public,anon,authenticated;
create trigger capture_completed_message_insight after insert or update of state,decision on public.ai_requests
  for each row execute function public.capture_message_insight();

-- Backfill completed classifications that predate this feature.
insert into public.message_insights(tenant_id,message_id,conversation_id,intent,topic,language,risk,summary,classified_at,updated_at)
select a.tenant_id,m.id,m.conversation_id,nullif(a.decision->>'intent',''),coalesce(nullif(btrim(a.decision->>'analyticsTopic'),''),nullif(btrim(a.decision->>'normalizedQuery'),'')),
  nullif(a.decision->>'language',''),coalesce(nullif(a.decision->>'risk',''),'none'),nullif(btrim(a.decision->>'summary'),''),
  coalesce(a.completed_at,a.created_at),now()
from public.ai_requests a join public.messages m on m.tenant_id=a.tenant_id
  and m.id=substring(a.request_key from '^message:([0-9a-fA-F-]{36})')::uuid
where a.state='completed' and a.decision->>'kind'='intent_classification' and a.request_key ~ '^message:[0-9a-fA-F-]{36}'
on conflict(tenant_id,message_id) do nothing;

create function public.get_chat_analytics(p_tenant uuid,p_from timestamptz,p_to timestamptz,p_granularity text default 'day')
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not public.is_tenant_member(p_tenant) then raise exception 'Analytics access denied'; end if;
  if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '2 years' then raise exception 'Invalid analytics period'; end if;
  if p_granularity not in ('day','week','month') then raise exception 'Invalid analytics granularity'; end if;

  with inbound as (
    select m.id,m.conversation_id,c.customer_id,m.occurred_at
    from public.messages m join public.conversations c on c.tenant_id=m.tenant_id and c.id=m.conversation_id
    where m.tenant_id=p_tenant and m.direction='inbound' and m.occurred_at>=p_from and m.occurred_at<p_to
  ), spam as (
    select i.message_id,i.conversation_id,c.customer_id,m.occurred_at
    from public.message_insights i join public.messages m on m.tenant_id=i.tenant_id and m.id=i.message_id
      join public.conversations c on c.tenant_id=i.tenant_id and c.id=i.conversation_id
    where i.tenant_id=p_tenant and i.risk='spam_or_fraud' and m.occurred_at>=p_from and m.occurred_at<p_to
  ), abuse as (
    select m.id as message_id,m.conversation_id,c.customer_id,m.occurred_at
    from public.messages m join public.conversations c on c.tenant_id=m.tenant_id and c.id=m.conversation_id
    where m.tenant_id=p_tenant and m.direction='inbound' and m.moderation_state='flagged' and m.occurred_at>=p_from and m.occurred_at<p_to
  ), complaints as (
    select e.id,e.conversation_id,c.customer_id,e.created_at
    from public.conversation_events e join public.conversations c on c.tenant_id=e.tenant_id and c.id=e.conversation_id
    where e.tenant_id=p_tenant and e.event_type='complaint' and e.created_at>=p_from and e.created_at<p_to
  ), contacts as (
    select e.id,e.conversation_id,c.customer_id,e.created_at
    from public.conversation_events e join public.conversations c on c.tenant_id=e.tenant_id and c.id=e.conversation_id
    where e.tenant_id=p_tenant and e.event_type='human_requested' and e.created_at>=p_from and e.created_at<p_to
  ), gaps as (
    select i.message_id,i.conversation_id,c.customer_id,m.occurred_at
    from public.message_insights i join public.messages m on m.tenant_id=i.tenant_id and m.id=i.message_id
      join public.conversations c on c.tenant_id=i.tenant_id and c.id=i.conversation_id
    where i.tenant_id=p_tenant and i.is_knowledge_gap and m.occurred_at>=p_from and m.occurred_at<p_to
  ), population as (
    select customer_id from inbound union select customer_id from spam union select customer_id from abuse
    union select customer_id from complaints union select customer_id from contacts union select customer_id from gaps
  ), customer_rows as (
    select cu.id,coalesce(nullif(btrim(cu.display_name),''),case when cu.whatsapp_username is not null then '@'||cu.whatsapp_username else 'WhatsApp customer' end) as name,
      cu.whatsapp_id as phone,cu.whatsapp_username as username,
      (select min(x.occurred_at) from inbound x where x.customer_id=cu.id) as first_contact,
      (select max(x.occurred_at) from inbound x where x.customer_id=cu.id) as last_contact,
      (select count(*) from inbound x where x.customer_id=cu.id) as inbound_messages,
      (select count(distinct x.conversation_id) from inbound x where x.customer_id=cu.id) as chats,
      (select count(*) from spam x where x.customer_id=cu.id) as spam_fraud_count,
      (select count(*) from abuse x where x.customer_id=cu.id) as abuse_count,
      (select count(*) from complaints x where x.customer_id=cu.id) as complaint_count,
      (select count(*) from contacts x where x.customer_id=cu.id) as contact_request_count,
      (select count(*) from gaps x where x.customer_id=cu.id) as knowledge_gap_count
    from public.customers cu join population p on p.customer_id=cu.id where cu.tenant_id=p_tenant
  ), facts as (
    select customer_id,occurred_at,'customers'::text metric from inbound
    union all select customer_id,occurred_at,'spam' from spam
    union all select customer_id,occurred_at,'abuse' from abuse
    union all select customer_id,created_at,'complaints' from complaints
    union all select customer_id,created_at,'contact' from contacts
  ), period_metrics as (
    select date_trunc(p_granularity,occurred_at) period,metric,count(distinct customer_id) value from facts group by 1,2
  ), periods as (
    select period,jsonb_build_object(
      'period',period,
      'customers',coalesce(max(value) filter(where metric='customers'),0),
      'spamOrFraud',coalesce(max(value) filter(where metric='spam'),0),
      'abuseOrSexualHarassment',coalesce(max(value) filter(where metric='abuse'),0),
      'complaints',coalesce(max(value) filter(where metric='complaints'),0),
      'contactRequests',coalesce(max(value) filter(where metric='contact'),0)
    ) value from period_metrics group by period
  ), topic_stats as (
    select lower(regexp_replace(btrim(i.topic),'\s+',' ','g')) topic_key,min(i.topic) topic,count(*) mentions,
      count(distinct c.customer_id) customers,max(m.occurred_at) last_seen,
      bool_or(i.is_knowledge_gap) has_gap
    from public.message_insights i join public.messages m on m.tenant_id=i.tenant_id and m.id=i.message_id
      join public.conversations c on c.tenant_id=i.tenant_id and c.id=i.conversation_id
    where i.tenant_id=p_tenant and i.topic is not null and char_length(btrim(i.topic))>=8
      and coalesce(i.intent,'') not in ('greeting','thanks','contact_details','human_followup','complaint','unrelated','ambiguous','career')
      and m.occurred_at>=p_from and m.occurred_at<p_to
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
    where i.tenant_id=p_tenant and i.intent='complaint' and i.topic is not null and m.occurred_at>=p_from and m.occurred_at<p_to
    group by 1 having count(*)>=2
  ), complaint_recommendations as (
    select 'complaint_theme'::text kind,topic,mentions,customers,last_seen,
      'Several customers raised a complaint about this topic. Review the related conversations and the underlying process.'::text reason
    from complaint_stats
  ), recommendations as (
    select * from faq_recommendations union all select * from complaint_recommendations
  )
  select jsonb_build_object(
    'summary',jsonb_build_object(
      'customers',(select count(distinct customer_id) from inbound),
      'chats',(select count(distinct conversation_id) from inbound),
      'inboundMessages',(select count(*) from inbound),
      'spamOrFraud',(select count(distinct customer_id) from spam),
      'abuseOrSexualHarassment',(select count(distinct customer_id) from abuse),
      'complaints',(select count(distinct customer_id) from complaints),
      'contactRequests',(select count(distinct customer_id) from contacts),
      'knowledgeGaps',(select count(distinct customer_id) from gaps)
    ),
    'series',coalesce((select jsonb_agg(value order by period) from periods),'[]'::jsonb),
    'customers',coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'name',name,'phone',phone,'username',username,'firstContact',first_contact,'lastContact',last_contact,
      'inboundMessages',inbound_messages,'chats',chats,'spamOrFraud',spam_fraud_count,'abuseOrSexualHarassment',abuse_count,
      'complaints',complaint_count,'contactRequests',contact_request_count,'knowledgeGaps',knowledge_gap_count
    ) order by last_contact desc nulls last,name) from customer_rows),'[]'::jsonb),
    'recommendations',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',kind,'topic',topic,'mentions',mentions,'customers',customers,'lastSeen',last_seen,'reason',reason
    ) order by mentions desc,last_seen desc) from recommendations),'[]'::jsonb)
  ) into result;
  return result;
end; $$;
revoke all on function public.get_chat_analytics(uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.get_chat_analytics(uuid,timestamptz,timestamptz,text) to authenticated;

commit;
