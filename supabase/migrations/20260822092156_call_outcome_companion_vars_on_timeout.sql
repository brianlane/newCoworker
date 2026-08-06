-- The call-wait timeout sweep must write the outcome's COMPANION vars too.
--
-- A place_ai_call step now declares three vars, not one: the coarse outcome,
-- a reason token, and a human label that gets templated straight into texts a
-- teammate reads. Every other path that resolves a call writes all three. This
-- sweep, the backstop for a hangup webhook that never arrived, still wrote
-- only the outcome, so a run resumed by TIMEOUT would leave
-- {{vars.call_outcome_label}} empty in the very message meant to explain what
-- happened, or worse, still holding a previous attempt's label in a retry
-- ladder that reuses one outcome var.
--
-- The reason is empty rather than invented: a lapsed wait means the webhook
-- never arrived, which is not itself a fact about the call. The label falls
-- back to the outcome's own phrase, matching callOutcomeLabel("no_answer") in
-- _shared/ai_flows/call_outcome_meta.ts. Keep the two in step.
--
-- grants: none (resume_overdue_call_waits): re-creating an existing function;
-- its revoke/grant posture is set below, unchanged from the original.

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
            jsonb_set(
              jsonb_set(
                context,
                array['vars', coalesce(context -> 'waiting_call' ->> 'save_as', 'call_outcome')],
                to_jsonb('no_answer'::text),
                true
              ),
              -- Companion 1: why. Empty because a lapsed wait says nothing
              -- about the call itself, only that its webhook never landed.
              -- Written anyway so a retry ladder reusing one outcome var can
              -- never read the PREVIOUS attempt's reason.
              array['vars', coalesce(context -> 'waiting_call' ->> 'save_as', 'call_outcome') || '_reason'],
              to_jsonb(''::text),
              true
            ),
            -- Companion 2: the same fact as a phrase a person can read.
            array['vars', coalesce(context -> 'waiting_call' ->> 'save_as', 'call_outcome') || '_label'],
            to_jsonb('no answer yet'::text),
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

revoke execute on function public.resume_overdue_call_waits() from public, anon, authenticated;
grant execute on function public.resume_overdue_call_waits() to service_role;

comment on function public.resume_overdue_call_waits is
  'Backstop for a place_ai_call whose end webhook never arrived: re-queues the run with the no_answer sentinel plus its reason/label companion vars, so the flow''s retry or alert branch runs with the same vars a normally-resumed call would have set.';
