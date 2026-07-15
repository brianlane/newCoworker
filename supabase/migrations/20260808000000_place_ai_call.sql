-- ---------------------------------------------------------------------------
-- AiFlow `place_ai_call` step: a batch run can place an outbound AI call and
-- park until the call ends.
--
-- The step dials through telnyx-voice-originate (same pre-dial probe +
-- post-dial budget reserve as every outbound AI call), then parks the run in
-- a new `awaiting_call` status (analogous to `awaiting_reply`, but resolved
-- by the call's end instead of an inbound SMS):
--
--   context.waiting_call - { save_as, marker, step_index, call_control_id,
--                            session_id }: which context.vars key receives
--                            the outcome and which leg we are waiting on.
--   respond_by_at        - (reused column) the wait ceiling;
--                          resume_overdue_call_waits() re-queues the run with
--                          the 'no_answer' sentinel once it passes, so a lost
--                          hangup webhook can never wedge the run.
--
-- The resume writers are the voice path, both status-guarded so only the
-- first outcome lands:
--   - the VPS bridge resumes with 'transferred' the moment its live-transfer
--     tool connects the callee to a human;
--   - telnyx-voice-call-end resumes on the leg's hangup with 'transferred' /
--     'answered' / 'no_answer' (from the session's transfer_initiated flag
--     and the reservation's answer_issued_at).
-- ---------------------------------------------------------------------------

-- Extend the run status check with the new parked state.
alter table public.ai_flow_runs
  drop constraint if exists ai_flow_runs_status_check;
alter table public.ai_flow_runs
  add constraint ai_flow_runs_status_check
  check (status in (
    'queued', 'running', 'awaiting_approval', 'awaiting_agent', 'awaiting_reply',
    'awaiting_call', 'done', 'failed', 'canceled'
  ));

-- Timeout sweep hot path (mirrors ai_flow_runs_reply_wait_idx).
create index if not exists ai_flow_runs_call_wait_idx
  on public.ai_flow_runs (respond_by_at) where status = 'awaiting_call';

comment on constraint ai_flow_runs_status_check on public.ai_flow_runs is
  'Run lifecycle: queued -> running -> (awaiting_approval | awaiting_agent | awaiting_reply | awaiting_call) -> done | failed | canceled. awaiting_call = a place_ai_call step is waiting for its outbound AI call to end (or the wait ceiling).';

-- ---------------------------------------------------------------------------
-- resume_overdue_call_waits: the call's end webhook never resumed the run
-- before the wait ceiling (lost webhook, dial that never rang, worker crash
-- between dial and park bookkeeping). Re-queue with the 'no_answer' sentinel
-- so the flow's retry/no-answer branch runs. waiting_call.result='timeout' is
-- stamped for the run-detail audit view. Mirrors resume_overdue_reply_waits;
-- safe to run every worker tick.
-- ---------------------------------------------------------------------------
create or replace function public.resume_overdue_call_waits()
returns int
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_count int;
begin
  update public.ai_flow_runs
  set status = 'queued',
      claimed_at = null,
      respond_by_at = null,
      context = jsonb_set(
        jsonb_set(
          jsonb_set(
            context,
            array['vars', coalesce(context -> 'waiting_call' ->> 'save_as', 'call_outcome')],
            to_jsonb('no_answer'::text),
            true
          ),
          -- Per-step resolution marker: the call step completes on re-entry
          -- instead of dialing the callee again.
          array['vars', coalesce(context -> 'waiting_call' ->> 'marker', '__called_unknown')],
          to_jsonb('1'::text),
          true
        ),
        '{waiting_call,result}',
        to_jsonb('timeout'::text),
        true
      )
  where status = 'awaiting_call'
    and respond_by_at is not null
    and respond_by_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Worker-only surface: the ai-flow-worker calls this with the service-role
-- key each tick. Revoke the default PUBLIC grant and grant service_role
-- explicitly so the lockdown posture can't strand the sweep.
revoke execute on function public.resume_overdue_call_waits() from public, anon, authenticated;
grant execute on function public.resume_overdue_call_waits() to service_role;

comment on function public.resume_overdue_call_waits is
  'Re-queue place_ai_call runs whose wait ceiling (respond_by_at) lapsed, writing the no_answer sentinel into context.vars[save_as] so the flow''s no-answer branch runs. Called every ai-flow-worker tick alongside resume_overdue_reply_waits.';

-- reclaim_stale_ai_flow_runs only touches status='running', so the new parked
-- state is already excluded (like the other awaiting_* states).
comment on function public.reclaim_stale_ai_flow_runs is
  'Return runs stuck in running past p_stale_minutes back to queued (worker crash recovery). Does not touch awaiting_approval, awaiting_agent, awaiting_reply, or awaiting_call (all wait on an external event, not the worker).';
