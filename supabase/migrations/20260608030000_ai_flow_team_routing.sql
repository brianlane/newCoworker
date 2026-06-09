-- ---------------------------------------------------------------------------
-- AiFlow team routing: the `route_to_team` step offers a lead to one team
-- agent at a time over SMS (reply 1 = claim, 2 = reject) with a timed
-- escalation. A run that is waiting on an agent parks in a new
-- `awaiting_agent` state (analogous to `awaiting_approval`, but resolved by an
-- agent's SMS reply or a timeout sweep instead of an owner dashboard action).
--
--   awaiting_agent_e164 - the agent currently being offered the lead; the
--                         telnyx-sms-inbound webhook matches an inbound 1/2 to
--                         a pending offer by (business_id, this column).
--   respond_by_at       - the offer deadline; escalate_overdue_agent_offers
--                         re-queues the run once it passes so the worker can
--                         move on to the next agent.
-- ---------------------------------------------------------------------------

-- Extend the run status check to allow the new parked state. The inline check
-- from the base migration is named ai_flow_runs_status_check (<table>_<col>_check).
alter table public.ai_flow_runs
  drop constraint if exists ai_flow_runs_status_check;
alter table public.ai_flow_runs
  add constraint ai_flow_runs_status_check
  check (status in (
    'queued', 'running', 'awaiting_approval', 'awaiting_agent',
    'done', 'failed', 'canceled'
  ));

alter table public.ai_flow_runs
  add column if not exists awaiting_agent_e164 text,
  add column if not exists respond_by_at timestamptz;

-- Escalation sweep hot path: parked offers ordered by their deadline (Pattern A
-- from the subscription grace sweep).
create index if not exists ai_flow_runs_agent_offer_idx
  on public.ai_flow_runs (respond_by_at) where status = 'awaiting_agent';

-- Inbound 1/2 lookup: match a replying agent to their pending offer.
create index if not exists ai_flow_runs_awaiting_agent_e164_idx
  on public.ai_flow_runs (business_id, awaiting_agent_e164)
  where status = 'awaiting_agent';

comment on column public.ai_flow_runs.awaiting_agent_e164 is
  'When status=awaiting_agent: the team agent (E.164) currently offered the lead by a route_to_team step. The telnyx-sms-inbound webhook matches an inbound 1/2 reply to this run via (business_id, awaiting_agent_e164).';
comment on column public.ai_flow_runs.respond_by_at is
  'When status=awaiting_agent: offer deadline. escalate_overdue_agent_offers() re-queues the run past this time so the worker escalates to the next agent.';

-- ---------------------------------------------------------------------------
-- reclaim_stale_ai_flow_runs: only ever touches status='running', so the new
-- awaiting_agent parked state is already excluded (like awaiting_approval).
-- Redefined here only to update the doc comment; the body is unchanged.
-- ---------------------------------------------------------------------------
comment on function public.reclaim_stale_ai_flow_runs is
  'Return runs stuck in running past p_stale_minutes back to queued (worker crash recovery). Does not touch awaiting_approval or awaiting_agent (both wait on an external event, not the worker).';

-- ---------------------------------------------------------------------------
-- escalate_overdue_agent_offers: an agent did not reply 1/2 before the offer
-- deadline. Re-queue the run (clearing the offer columns) and stamp
-- context.routing.last_event='timeout' so the route_to_team handler knows to add
-- the timed-out agent to routing.tried[] and offer the next one. Mirrors the
-- queued->running reclaim pattern; safe to run every worker tick.
-- ---------------------------------------------------------------------------
create or replace function public.escalate_overdue_agent_offers()
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  update public.ai_flow_runs
  set status = 'queued',
      claimed_at = null,
      awaiting_agent_e164 = null,
      respond_by_at = null,
      -- Merge into context.routing (preserve tried[]/offered) without requiring
      -- the key to pre-exist: jsonb_set's create_missing only creates leaves.
      context = jsonb_set(
        context,
        '{routing}',
        coalesce(context -> 'routing', '{}'::jsonb)
          || jsonb_build_object('last_event', 'timeout'),
        true
      )
  where status = 'awaiting_agent'
    and respond_by_at is not null
    and respond_by_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.escalate_overdue_agent_offers is
  'Re-queue route_to_team runs whose agent offer (respond_by_at) lapsed, stamping context.routing.last_event=timeout so the worker escalates to the next agent. Called every ai-flow-worker tick alongside reclaim_stale_ai_flow_runs.';
