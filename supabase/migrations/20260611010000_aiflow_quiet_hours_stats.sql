-- ---------------------------------------------------------------------------
-- AiFlows: honest retry stats + deferred sends (lead-contact quiet hours).
--
--   error_retry_count - counts ONLY transient-error retries. attempt_count
--                       (bumped on every claim) also counts benign re-claims:
--                       route_to_team offer escalations, approval resumes, and
--                       quiet-hour deferrals all re-queue the run, so a healthy
--                       routed run can show attempt 3+ without ever erroring.
--                       Dead-lettering and the dashboards now key off this
--                       column instead so "attempts" can't read as failures.
--   earliest_claim_at - when set, the claim RPC skips the run until the time
--                       passes. Used by send_sms quiet hours: a lead text that
--                       would go out overnight is parked until the morning
--                       resume time instead of being sent or dropped.
-- ---------------------------------------------------------------------------

alter table public.ai_flow_runs
  add column if not exists error_retry_count int not null default 0,
  add column if not exists earliest_claim_at timestamptz;

comment on column public.ai_flow_runs.error_retry_count is
  'Transient-error retries only (bumped by the worker''s handleRunThrow). Unlike attempt_count, never incremented by benign re-claims (offer escalation, approval resume, quiet-hour deferral); drives dead-lettering and the run-stats UI.';
comment on column public.ai_flow_runs.earliest_claim_at is
  'When set, claim_ai_flow_runs skips this queued run until the time passes. Set by send_sms quiet-hour deferrals so an overnight lead text goes out at the morning resume time.';

-- ---------------------------------------------------------------------------
-- claim_ai_flow_runs: same FOR UPDATE SKIP LOCKED lease as before, but a run
-- parked by quiet hours (earliest_claim_at in the future) is not claimable yet.
-- ---------------------------------------------------------------------------
create or replace function public.claim_ai_flow_runs(p_limit int default 5)
returns setof public.ai_flow_runs
language plpgsql
as $$
begin
  return query
  with claimed as (
    select r.id
    from public.ai_flow_runs r
    where r.status = 'queued'
      and (r.earliest_claim_at is null or r.earliest_claim_at <= now())
    order by r.created_at
    for update skip locked
    limit greatest(1, p_limit)
  )
  update public.ai_flow_runs r
  set status = 'running',
      claimed_at = now(),
      attempt_count = r.attempt_count + 1,
      earliest_claim_at = null
  from claimed
  where r.id = claimed.id
  returning r.*;
end;
$$;

comment on function public.claim_ai_flow_runs is
  'Atomically lease up to p_limit queued ai_flow_runs to a worker (FOR UPDATE SKIP LOCKED), flipping queued->running and stamping claimed_at. Skips runs whose earliest_claim_at (quiet-hour deferral) has not passed yet. Mirrors claim_sms_inbound_jobs.';
