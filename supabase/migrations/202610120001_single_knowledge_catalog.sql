begin;

-- English is the established business source of truth. Remove the parallel
-- localized catalog before making that invariant structural.
delete from public.business_facts where locale <> 'en';
delete from public.faqs where locale <> 'en';

drop trigger if exists assign_branch_order on public.business_facts;
drop function if exists public.assign_branch_display_order();
drop function if exists public.reorder_branches(uuid,text,uuid[]);
drop index if exists public.business_facts_branch_order;

alter table public.business_facts
  drop constraint if exists business_facts_tenant_id_fact_key_locale_key,
  drop column locale;

alter table public.faqs
  drop column locale;

alter table public.business_facts
  add constraint business_facts_tenant_fact_key_key unique (tenant_id,fact_key);

with ranked as (
  select id,row_number() over(
    partition by tenant_id
    order by display_order nulls last,created_at,id
  )-1 as position
  from public.business_facts
  where category='branch'
)
update public.business_facts facts
set display_order=ranked.position
from ranked
where facts.id=ranked.id;

create index business_facts_branch_order
  on public.business_facts(tenant_id,display_order,created_at,id)
  where category='branch';

create function public.assign_branch_display_order()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.category='branch' then
    perform pg_advisory_xact_lock(hashtextextended('branch-order:'||new.tenant_id::text,0));
    select coalesce(max(display_order),-1)+1 into new.display_order
    from public.business_facts
    where tenant_id=new.tenant_id and category='branch';
  end if;
  return new;
end;
$$;

create trigger assign_branch_order
before insert on public.business_facts
for each row execute function public.assign_branch_display_order();

create function public.reorder_branches(p_tenant uuid,p_branch_ids uuid[])
returns void language plpgsql set search_path='' as $$
declare expected integer; supplied integer; changed integer;
begin
  if not public.is_tenant_member(p_tenant,array['owner','admin']) then
    raise exception 'Owner or admin access required';
  end if;
  if p_branch_ids is null then
    raise exception 'Invalid branch order';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('branch-order:'||p_tenant::text,0));
  select count(*) into expected from public.business_facts
    where tenant_id=p_tenant and category='branch';
  select count(distinct branch_id) into supplied from unnest(p_branch_ids) branch_id;

  if cardinality(p_branch_ids)<>expected or supplied<>expected or exists(
    select 1 from unnest(p_branch_ids) branch_id
    left join public.business_facts facts on facts.id=branch_id and facts.tenant_id=p_tenant
      and facts.category='branch'
    where facts.id is null
  ) then
    raise exception 'Branch order must contain every branch exactly once';
  end if;

  with desired as (
    select branch_id,ordinality::integer-1 as position
    from unnest(p_branch_ids) with ordinality ordered(branch_id,ordinality)
  )
  update public.business_facts facts set display_order=desired.position
  from desired where facts.id=desired.branch_id and facts.tenant_id=p_tenant
    and facts.category='branch';
  get diagnostics changed=row_count;
  if changed<>expected then raise exception 'Branch order changed while saving'; end if;
end;
$$;

revoke all on function public.reorder_branches(uuid,uuid[]) from public,anon;
grant execute on function public.reorder_branches(uuid,uuid[]) to authenticated,service_role;

commit;
