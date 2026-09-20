begin;
-- Remove the owner's obsolete non-renewing development cap; retain usage accounting.
-- A NULL cap means uncapped. Existing spend/reservations and all access rules are preserved.
alter table public.ai_budget drop constraint ai_budget_cap_nano_check;
alter table public.ai_budget alter column cap_nano drop not null;
alter table public.ai_budget alter column cap_nano drop default;
update public.ai_budget set cap_nano=null where singleton;
alter table public.ai_budget add constraint ai_budget_cap_nano_check check (cap_nano is null or cap_nano>=0);
-- Old in-flight reservations remain valid across the rolling deployment.
alter table public.ai_requests drop constraint ai_requests_reserved_nano_check;
alter table public.ai_requests add constraint ai_requests_reserved_nano_check check (reserved_nano in (10640000,12800000));
alter table public.ai_requests drop constraint ai_requests_output_tokens_check;
alter table public.ai_requests add constraint ai_requests_output_tokens_check check (output_tokens is null or output_tokens between 0 and 2000);

create or replace function public.reserve_ai_request(p_tenant uuid,p_key text,p_purpose text,p_model text,p_prompt text)
returns jsonb language plpgsql set search_path='' as $$
declare allowance public.ai_budget; existing public.ai_requests; request_id uuid;
begin
  select * into allowance from public.ai_budget where singleton for update;
  if allowance.singleton is null then raise exception 'AI allowance missing'; end if;
  select * into existing from public.ai_requests where tenant_id=p_tenant and request_key=p_key;
  if existing.id is not null then
    return jsonb_build_object('status',existing.state,'id',existing.id,'decision',existing.decision);
  end if;
  if allowance.cap_nano is not null and allowance.allocated_nano + 12800000 > allowance.cap_nano then
    return jsonb_build_object('status','budget_exhausted');
  end if;
  insert into public.ai_requests(tenant_id,request_key,purpose,model,prompt_version,reserved_nano)
    values(p_tenant,p_key,p_purpose,p_model,p_prompt,12800000) returning id into request_id;
  update public.ai_budget set allocated_nano=allocated_nano+12800000 where singleton;
  return jsonb_build_object('status','new','id',request_id);
end; $$;

create or replace function public.finish_ai_request(p_tenant uuid,p_id uuid,p_state text,p_input integer,p_output integer,p_latency integer,p_decision jsonb,p_error text)
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
    if p_input not between 0 and 24000 or p_output not between 0 and 2000 then raise exception 'Usage outside reserved bounds'; end if;
    charge:=p_input::bigint*400 + p_output::bigint*1600;
  end if;
  if p_state='completed' and (p_decision is null or p_input is null or p_output is null) then raise exception 'Incomplete AI result'; end if;
  update public.ai_requests set state=p_state,charged_nano=charge,input_tokens=p_input,output_tokens=p_output,
    latency_ms=p_latency,decision=p_decision,error_code=p_error,completed_at=now() where id=p_id;
  update public.ai_budget set allocated_nano=allocated_nano-request.reserved_nano+charge where singleton;
end; $$;


commit;
