-- Name the sender behind unattributed Telnyx spend.
--
-- `telnyx_cost_daily.business_id` goes NULL when neither leg of a detail
-- record matches a tenant DID, and the Costs page paints that bucket orange
-- as a leak detector. It could report a dollar amount and nothing else, so
-- every recurring platform sender read as a fresh unexplained leak.
--
-- The August 2026 reconciliation against the July invoice found the whole
-- bucket was two known platform senders, neither of which can ever match a
-- tenant DID:
--   * +16028384497, the dedicated P2P international SMS gateway long code
--     (TELNYX_INTL_GATEWAY_E164), since released;
--   * new_coworker_jut3q1af_agent, the RCS agent id, which is not a phone
--     number at all, so the digits-only DID matcher can never match it.
--
-- Recording the sender identity on unattributed rows turns "$0.03 matched no
-- tenant DID" into "$0.03 from the international gateway": a leak you can
-- act on, or a platform cost you can recognize on sight. NULL on attributed
-- rows (the sender there IS the tenant's own DID, which the business_id
-- already names).
alter table public.telnyx_cost_daily
  add column if not exists sender text;

-- Existing rows keep sender NULL until the next sync re-aggregates the
-- rolling window; the Costs page renders an unnamed unattributed row exactly
-- as it did before, so backfill is not required for correctness.

create or replace function public.replace_telnyx_cost_window(
  p_window_start date,
  p_rows jsonb
) returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  delete from public.telnyx_cost_daily where day >= p_window_start;
  insert into public.telnyx_cost_daily
    (day, business_id, record_type, direction, record_count,
     cost_micros, carrier_fee_micros, billed_seconds, sender)
  select
    (r->>'day')::date,
    nullif(r->>'business_id', '')::uuid,
    r->>'record_type',
    r->>'direction',
    coalesce((r->>'record_count')::integer, 0),
    coalesce((r->>'cost_micros')::bigint, 0),
    coalesce((r->>'carrier_fee_micros')::bigint, 0),
    coalesce((r->>'billed_seconds')::bigint, 0),
    nullif(r->>'sender', '')
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke execute on function public.replace_telnyx_cost_window(date, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_telnyx_cost_window(date, jsonb)
  to service_role;
