-- Per-contact FIFO serialization for the SMS inbound job queue.
--
-- Incident (Truly Insurance, 2026-07-13): a customer sent several texts a few
-- seconds apart while Rowboat was intermittently failing (upstream Gemini
-- 503s). Each inbound was an independent job, jobs were claimed and retried
-- concurrently, and the replies landed OUT OF ORDER — the answer to an
-- earlier text arrived after the answer to a later one, the model re-asked
-- questions it had already asked, and the customer double-texted (multiplying
-- turns further).
--
-- Fix: claim_sms_inbound_jobs now claims a pending job only when it is the
-- OLDEST active job for its (business_id, customer_e164) — i.e. no earlier
-- pending job and no currently-processing job exists for the same contact.
-- Jobs for different contacts still drain in parallel; a contact's replies
-- now go out strictly in inbound order, and each turn sees the previous
-- turn's reply in the Rowboat thread before running.
--
-- NULL customer_e164 rows (legacy / malformed payloads that dead-letter
-- immediately) are exempt: `p.customer_e164 = j.customer_e164` is null-false,
-- so they never serialize against anything, matching pre-fix behavior.
--
-- A crashed worker leaves a 'processing' row that would block its contact's
-- queue; the existing stale-claim recovery sweep (voice_run_maintenance_sweeps
-- → stuck sms_inbound_jobs) resets those to pending on its normal schedule,
-- exactly as before this change.

create index if not exists idx_sms_inbound_jobs_contact_active
  on sms_inbound_jobs (business_id, customer_e164, created_at)
  where status in ('pending', 'processing');

create or replace function claim_sms_inbound_jobs(p_limit integer default 5)
returns setof sms_inbound_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with cte as (
    select j.id
    from sms_inbound_jobs j
    where j.status = 'pending'
      and not exists (
        select 1
        from sms_inbound_jobs p
        where p.business_id = j.business_id
          and p.customer_e164 = j.customer_e164
          and p.id <> j.id
          and (
            p.status = 'processing'
            or (
              p.status = 'pending'
              and (p.created_at, p.id) < (j.created_at, j.id)
            )
          )
      )
    order by j.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update sms_inbound_jobs j
  set
    status = 'processing',
    processing_started_at = now(),
    attempt_count = j.attempt_count + 1,
    outbound_idempotency_key = coalesce(j.outbound_idempotency_key, gen_random_uuid()),
    updated_at = now()
  from cte
  where j.id = cte.id
  returning j.*;
end;
$$;

grant execute on function claim_sms_inbound_jobs(integer) to service_role;

comment on function public.claim_sms_inbound_jobs(integer) is
  'Claims pending SMS inbound jobs for the worker, serialized per contact: only the oldest pending job for a (business_id, customer_e164) is claimable, and never while another job for that contact is processing. Keeps a rapid-fire texter''s replies in inbound order (2026-07-13 duplicate-reply incident).';
