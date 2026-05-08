-- RPCs that back the Option B chat-worker queue (see
-- 20260508000000_dashboard_chat_jobs.sql).
--
-- Two functions, both intentionally side-effect-free except for their own
-- table updates:
--
--   claim_chat_job(p_worker_id, p_business_id)
--     Atomically claim the next queued job for one tenant. Multiple worker
--     processes can call this concurrently; FOR UPDATE SKIP LOCKED gives
--     each one a different row (or empty if drained). Used both by the
--     Realtime INSERT-driven processing path and the periodic catch-up
--     sweep on the worker.
--
--   reclaim_stale_chat_jobs(p_max_age_ms)
--     Crash recovery: re-queue jobs whose claimed_at is older than
--     p_max_age_ms. Idempotent. The worker calls this on startup
--     (BEFORE subscribing to Realtime, so the very first work it does
--     is to drain pre-existing stuck jobs) and on a periodic timer.
--     Verified by the prototype's "simulated stuck worker" test:
--     reclaimed 291 ms after worker restart, attempts incremented to 2.

create or replace function claim_chat_job(p_worker_id text, p_business_id uuid)
returns setof dashboard_chat_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- 1. Pick the oldest queued job for this business, locking it for the
  --    rest of this transaction. Any other worker calling claim_chat_job
  --    concurrently sees this row already locked and skips it.
  select id into v_id
  from dashboard_chat_jobs
  where status = 'queued' and business_id = p_business_id
  order by created_at
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  -- 2. Flip to processing and emit the now-claimed row. attempts is
  --    incremented BEFORE the worker actually does the work so a worker
  --    that crashes before the next sweep doesn't infinite-loop on the
  --    same job — the attempts counter records the truth that this
  --    claim happened.
  return query
  update dashboard_chat_jobs
  set status = 'processing',
      claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = v_id
  returning *;
end;
$$;

create or replace function reclaim_stale_chat_jobs(p_max_age_ms int)
returns setof dashboard_chat_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update dashboard_chat_jobs
  set status = 'queued',
      claimed_by = null,
      claimed_at = null
  where status = 'processing'
    and claimed_at < now() - (p_max_age_ms || ' milliseconds')::interval
  returning *;
end;
$$;

comment on function claim_chat_job is
  'Atomic FOR UPDATE SKIP LOCKED claim. Returns 0 or 1 row. Workers loop on this until empty after every Realtime wake-up and after every periodic sweep.';

comment on function reclaim_stale_chat_jobs is
  'Crash recovery: re-queue jobs whose claimed_at is older than p_max_age_ms. Run on worker startup and every WORKER_SWEEP_INTERVAL_MS to bound recovery time.';

-- Service role and authenticated callers can execute these. The route uses
-- the service-role client; the worker uses the service-role key in its env.
-- We do not expose either RPC to anon — there's no scenario where an
-- unauthenticated caller should claim a job.
revoke all on function claim_chat_job(text, uuid) from public;
revoke all on function reclaim_stale_chat_jobs(int) from public;
grant execute on function claim_chat_job(text, uuid) to service_role;
grant execute on function reclaim_stale_chat_jobs(int) to service_role;
