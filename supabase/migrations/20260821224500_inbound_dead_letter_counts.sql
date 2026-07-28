-- Exact per-tenant count of inbound texts the platform could not process.
--
-- The admin card needs two different things: a short list of recent rows to read,
-- and a TRUE count per tenant. Deriving the second from the first is wrong in two
-- ways that both hide the problem it exists to surface: a single noisy tenant
-- crowds every other tenant out of the sample, and a per-tenant number taken from
-- a capped scan understates that tenant without saying so.
--
-- A grouped count is not expressible through the JS client, so it lives here.
-- Cheap: the (status, created_at) index already exists for the pending-job scan.
create or replace function public.inbound_dead_letter_counts(p_since timestamptz)
returns table (business_id uuid, failure_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select j.business_id, count(*)::bigint as failure_count
  from sms_inbound_jobs j
  where j.status = 'dead_letter'
    and j.deleted_at is null
    and (p_since is null or j.created_at >= p_since)
  group by j.business_id
  order by failure_count desc, j.business_id;
$$;

comment on function public.inbound_dead_letter_counts(timestamptz) is
  'Exact count of dead-lettered inbound SMS jobs per business since p_since (null = all time), for the admin inbound-failures card.';

revoke execute on function public.inbound_dead_letter_counts(timestamptz) from public;
grant execute on function public.inbound_dead_letter_counts(timestamptz) to service_role;
