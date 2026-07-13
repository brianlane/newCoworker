-- The production Postgres enforces WHERE clauses on DELETE (safeupdate),
-- which rejected the snapshot function's unqualified `delete from
-- hostinger_vps_costs` on the first live sync ("DELETE requires a WHERE
-- clause"). Qualify it on the non-null primary key — semantically still
-- "all rows". Already applied to prod (2026-07-12); this file keeps the
-- repo's migration history in lockstep.

create or replace function public.replace_hostinger_vps_costs(
  p_rows jsonb
) returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  delete from public.hostinger_vps_costs where subscription_id is not null;
  insert into public.hostinger_vps_costs
    (subscription_id, vm_id, hostname, plan, status, billing_period,
     billing_period_unit, total_price_cents, renewal_price_cents,
     monthly_price_cents, is_auto_renewed, next_billing_at, expires_at,
     assigned_business_id)
  select
    r->>'subscription_id',
    (r->>'vm_id')::bigint,
    r->>'hostname',
    r->>'plan',
    r->>'status',
    (r->>'billing_period')::integer,
    r->>'billing_period_unit',
    (r->>'total_price_cents')::integer,
    (r->>'renewal_price_cents')::integer,
    (r->>'monthly_price_cents')::integer,
    (r->>'is_auto_renewed')::boolean,
    (r->>'next_billing_at')::timestamptz,
    (r->>'expires_at')::timestamptz,
    nullif(r->>'assigned_business_id', '')::uuid
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke execute on function public.replace_hostinger_vps_costs(jsonb)
  from public, anon, authenticated;
