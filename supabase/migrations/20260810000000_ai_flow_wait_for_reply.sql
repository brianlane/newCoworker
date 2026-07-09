-- ---------------------------------------------------------------------------
-- AiFlow `wait_for_reply` step: a run can park until the lead texts back.
--
-- A `wait_for_reply` step parks the run in a new `awaiting_reply` status
-- (analogous to `awaiting_agent`, but resolved by the LEAD's inbound SMS
-- instead of a teammate's 1/2 offer reply):
--
--   context.waiting_reply - { from, save_as, step_index }: who we are waiting
--                           on and which context.vars key receives the reply.
--   respond_by_at         - (reused column) the wait timeout;
--                           resume_overdue_reply_waits() re-queues the run
--                           with the no-reply sentinel ('no_reply') once it
--                           passes ("" can't be matched by a when-condition,
--                           whose equals/notEquals require a non-empty value).
--
-- The telnyx-sms-inbound webhook matches an inbound SMS to a parked run via
-- (business_id, context.waiting_reply.from), writes the reply text into
-- context.vars[save_as], re-queues the run, and suppresses the default AI
-- conversational reply for that message (the flow owns the turn, same
-- philosophy as options.suppressDefaultReply).
-- ---------------------------------------------------------------------------

-- Extend the run status check with the new parked state.
alter table public.ai_flow_runs
  drop constraint if exists ai_flow_runs_status_check;
alter table public.ai_flow_runs
  add constraint ai_flow_runs_status_check
  check (status in (
    'queued', 'running', 'awaiting_approval', 'awaiting_agent', 'awaiting_reply',
    'done', 'failed', 'canceled'
  ));

-- Timeout sweep hot path (mirrors ai_flow_runs_agent_offer_idx).
create index if not exists ai_flow_runs_reply_wait_idx
  on public.ai_flow_runs (respond_by_at) where status = 'awaiting_reply';

-- Inbound lookup: match a replying lead to their parked run. The waiting
-- number lives in context (jsonb), so index the extracted expression.
create index if not exists ai_flow_runs_waiting_reply_from_idx
  on public.ai_flow_runs (business_id, ((context -> 'waiting_reply') ->> 'from'))
  where status = 'awaiting_reply';

comment on constraint ai_flow_runs_status_check on public.ai_flow_runs is
  'Run lifecycle: queued -> running -> (awaiting_approval | awaiting_agent | awaiting_reply) -> done | failed | canceled. awaiting_reply = a wait_for_reply step is waiting for the lead''s inbound SMS (or its timeout).';

-- ---------------------------------------------------------------------------
-- resume_overdue_reply_waits: the lead did not text back before the wait
-- timeout. Re-queue the run with the no-reply sentinel: context.vars[save_as]
-- is set to 'no_reply' so the flow's `when: { var: save_as, equals:
-- "no_reply" }` branch runs. waiting_reply.result='timeout' is stamped for
-- the run-detail audit view. Mirrors escalate_overdue_agent_offers; safe to
-- run every worker tick.
-- ---------------------------------------------------------------------------
create or replace function public.resume_overdue_reply_waits()
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
          context,
          array['vars', coalesce(context -> 'waiting_reply' ->> 'save_as', 'reply_text')],
          to_jsonb('no_reply'::text),
          true
        ),
        '{waiting_reply,result}',
        to_jsonb('timeout'::text),
        true
      )
  where status = 'awaiting_reply'
    and respond_by_at is not null
    and respond_by_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.resume_overdue_reply_waits() from public, anon, authenticated;

comment on function public.resume_overdue_reply_waits is
  'Re-queue wait_for_reply runs whose timeout (respond_by_at) lapsed, writing the no_reply sentinel into context.vars[save_as] so the flow''s no-reply branch runs. Called every ai-flow-worker tick alongside escalate_overdue_agent_offers.';

-- reclaim_stale_ai_flow_runs only touches status='running', so the new parked
-- state is already excluded (like awaiting_approval / awaiting_agent).
comment on function public.reclaim_stale_ai_flow_runs is
  'Return runs stuck in running past p_stale_minutes back to queued (worker crash recovery). Does not touch awaiting_approval, awaiting_agent, or awaiting_reply (all wait on an external event, not the worker).';
