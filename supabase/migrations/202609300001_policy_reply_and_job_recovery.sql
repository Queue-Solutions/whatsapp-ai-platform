begin;

-- Deterministic business-policy replies do not cite mutable knowledge records,
-- but they must still pass the same final send eligibility checks. Keep the
-- allowlist deliberately narrow so this cannot become an ungrounded AI bypass.
create function public.prepare_policy_reply(p_job uuid,p_lease uuid,p_body text,p_reason text)
returns jsonb language plpgsql set search_path='' as $$
begin
  if p_reason is distinct from 'live_price_information' then
    raise exception 'Invalid policy reply reason';
  end if;
  return public.prepare_message_reply(p_job,p_lease,p_body);
end; $$;

-- A failure before a durable send intent is safe to retry immediately. This
-- releases only the exact processing lease; sending jobs remain untouched so
-- uncertain external outcomes can never be duplicated.
create function public.recover_processing_job(p_job uuid,p_lease uuid,p_code text)
returns text language plpgsql set search_path='' as $$
declare j public.message_jobs; recovered_state text;
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Invalid recovery code';
  end if;
  select * into j from public.message_jobs where id=p_job for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease then
    raise exception 'Invalid processing lease';
  end if;
  recovered_state:=case when j.attempts>=3 then 'failed' else 'pending' end;
  update public.message_jobs set state=recovered_state,error_code=p_code,leased_until=null where id=p_job;
  return recovered_state;
end; $$;

revoke all on function public.prepare_policy_reply(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.recover_processing_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_policy_reply(uuid,uuid,text,text),public.recover_processing_job(uuid,uuid,text) to service_role;

commit;
