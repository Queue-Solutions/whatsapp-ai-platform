begin;

-- One shared, non-renewing development allowance. Nanodollars avoid rounding drift.
create table public.ai_budget (
  singleton boolean primary key default true check (singleton),
  cap_nano bigint not null default 250000000 check (cap_nano between 0 and 250000000),
  allocated_nano bigint not null default 0 check (allocated_nano >= 0 and allocated_nano <= cap_nano)
);
insert into public.ai_budget(singleton) values(true);
create table public.ai_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  request_key text not null check (length(request_key) between 1 and 200),
  purpose text not null check (purpose in ('whatsapp','acceptance')),
  model text not null check (model = 'gpt-4.1-mini-2025-04-14'),
  prompt_version text not null,
  state text not null default 'reserved' check (state in ('reserved','completed','failed')),
  reserved_nano bigint not null check (reserved_nano = 10640000),
  charged_nano bigint,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  decision jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(tenant_id,request_key),
  check (charged_nano is null or charged_nano between 0 and reserved_nano),
  check (input_tokens is null or input_tokens between 0 and 24000),
  check (output_tokens is null or output_tokens between 0 and 650),
  check (latency_ms is null or latency_ms >= 0)
);
alter table public.ai_budget enable row level security;
alter table public.ai_requests enable row level security;
revoke all on public.ai_budget,public.ai_requests from public,anon,authenticated;
grant all on public.ai_budget,public.ai_requests to service_role;
grant select on public.ai_requests to authenticated;
create policy tenant_ai_read on public.ai_requests for select to authenticated using(public.is_tenant_member(tenant_id));

create function public.reserve_ai_request(p_tenant uuid,p_key text,p_purpose text,p_model text,p_prompt text)
returns jsonb language plpgsql set search_path='' as $$
declare allowance public.ai_budget; existing public.ai_requests; request_id uuid;
begin
  select * into allowance from public.ai_budget where singleton for update;
  if allowance.singleton is null then raise exception 'AI allowance missing'; end if;
  select * into existing from public.ai_requests where tenant_id=p_tenant and request_key=p_key;
  if existing.id is not null then
    return jsonb_build_object('status',existing.state,'id',existing.id,'decision',existing.decision);
  end if;
  if allowance.allocated_nano + 10640000 > allowance.cap_nano then
    return jsonb_build_object('status','budget_exhausted');
  end if;
  insert into public.ai_requests(tenant_id,request_key,purpose,model,prompt_version,reserved_nano)
    values(p_tenant,p_key,p_purpose,p_model,p_prompt,10640000) returning id into request_id;
  update public.ai_budget set allocated_nano=allocated_nano+10640000 where singleton;
  return jsonb_build_object('status','new','id',request_id);
end; $$;

create function public.finish_ai_request(p_tenant uuid,p_id uuid,p_state text,p_input integer,p_output integer,p_latency integer,p_decision jsonb,p_error text)
returns void language plpgsql set search_path='' as $$
declare request public.ai_requests; charge bigint;
begin
  -- Same lock order as reservation. A crash/timeout keeps the full reservation.
  perform 1 from public.ai_budget where singleton for update;
  select * into request from public.ai_requests where id=p_id and tenant_id=p_tenant for update;
  if request.id is null then raise exception 'Unknown AI request'; end if;
  if request.state <> 'reserved' then return; end if;
  if p_state not in ('completed','failed') then raise exception 'Invalid AI state'; end if;
  if p_input is null or p_output is null then charge:=request.reserved_nano;
  else
    if p_input not between 0 and 24000 or p_output not between 0 and 650 then raise exception 'Usage outside reserved bounds'; end if;
    charge:=p_input::bigint*400 + p_output::bigint*1600;
  end if;
  if p_state='completed' and (p_decision is null or p_input is null or p_output is null) then raise exception 'Incomplete AI result'; end if;
  update public.ai_requests set state=p_state,charged_nano=charge,input_tokens=p_input,output_tokens=p_output,
    latency_ms=p_latency,decision=p_decision,error_code=p_error,completed_at=now() where id=p_id;
  update public.ai_budget set allocated_nano=allocated_nano-request.reserved_nano+charge where singleton;
end; $$;

-- Wrap the established send-intent guard; approval changes and handoff are checked atomically.
create function public.prepare_ai_reply(p_job uuid,p_lease uuid,p_body text,p_action text,p_sources jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare j public.message_jobs; m public.messages; source jsonb; source_time timestamptz; prepared jsonb;
begin
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease or j.leased_until<now() then raise exception 'Invalid job lease'; end if;
  if p_action is null or p_action not in ('answer','clarify','unavailable','handoff','suppress') then raise exception 'Invalid AI action'; end if;
  if p_sources is null or jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources)>40 then raise exception 'Invalid AI sources'; end if;
  if p_action='suppress' then
    update public.message_jobs set state='skipped',error_code='ai_context_ineligible' where id=p_job;
    return null;
  end if;
  if p_action='answer' and jsonb_array_length(p_sources)=0 then raise exception 'Ungrounded answer'; end if;
  for source in select value from jsonb_array_elements(p_sources) loop
    source_time:=null;
    if source->>'kind'='faq' then
      select updated_at into source_time from public.faqs where id=(source->>'id')::uuid and tenant_id=j.tenant_id and is_published and btrim(answer)<>'' for share;
    elsif source->>'kind'='fact' then
      select updated_at into source_time from public.business_facts where id=(source->>'id')::uuid and tenant_id=j.tenant_id and is_published for share;
    end if;
    if source_time is null or source_time is distinct from (source->>'updatedAt')::timestamptz then
      update public.message_jobs set state='skipped',error_code='approved_knowledge_changed' where id=p_job;
      return null;
    end if;
  end loop;
  prepared:=public.prepare_message_reply(p_job,p_lease,p_body);
  if prepared is not null and p_action='handoff' then
    select * into m from public.messages where id=j.inbound_message_id;
    update public.conversations set automation_mode='human' where id=m.conversation_id and tenant_id=j.tenant_id;
  end if;
  return prepared;
end; $$;
revoke all on function public.reserve_ai_request(uuid,text,text,text,text),public.finish_ai_request(uuid,uuid,text,integer,integer,integer,jsonb,text),public.prepare_ai_reply(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_ai_request(uuid,text,text,text,text),public.finish_ai_request(uuid,uuid,text,integer,integer,integer,jsonb,text),public.prepare_ai_reply(uuid,uuid,text,text,jsonb) to service_role;
commit;
