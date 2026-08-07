-- Atomic writer for a "reach a teammate" B-leg outcome.
--
-- The assistant dials a teammate on a second leg while the caller keeps
-- talking to it. Whether that teammate actually PICKED UP is learned only from
-- Telnyx webhooks, and it is written onto the caller's session row because the
-- bridge (which runs on a VPS and receives no webhooks) polls there.
--
-- Doing that as read-modify-write in the webhook is racy in a way that costs a
-- real person: `call.answered` and `call.hangup` are separate deliveries and
-- can be in flight together, so both can read the same prior state, both can
-- decide they are allowed to write, and the later write wins. If the one that
-- loses is the `answered`, the bridge never learns the teammate picked up: it
-- apologizes to a caller who actually got through and leaves the teammate
-- holding a dead line.
--
-- So the precedence check and the write happen in ONE statement. The three
-- clauses below mirror reachOutcomeShouldApply() in
-- _shared/ai_flows/../voice_reach.ts, which is the readable specification of
-- the same rule and carries its unit tests. Keep the two in step.
--
--   1. nothing recorded yet            -> record
--   2. a NEWER attempt                 -> record (the ladder moved on)
--   3. an OLDER attempt                -> ignore (a late event from a leg the
--                                         ladder already hung up, which can
--                                         easily land after the next teammate
--                                         answered)
--   4. the SAME attempt, answered then -> ignore (the teammate hung up on a
--      no_answer                          real conversation; it is not a miss)

create or replace function public.record_reach_outcome(
  p_a_leg text,
  p_attempt int,
  p_status text,
  p_b_leg text
)
returns boolean
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_rows int;
begin
  if p_status not in ('answered', 'no_answer') then
    raise exception 'record_reach_outcome: bad status %', p_status;
  end if;

  update public.voice_handoff_sessions
  set context = jsonb_set(
        coalesce(context, '{}'::jsonb),
        '{reach}',
        jsonb_build_object(
          'attempt', to_jsonb(p_attempt),
          'status', to_jsonb(p_status),
          'b_leg', to_jsonb(p_b_leg)
        ),
        true
      )
  where call_control_id = p_a_leg
    and (
      -- 1. nothing recorded yet
      context -> 'reach' is null
      -- 2. a newer attempt always wins
      or (context -> 'reach' ->> 'attempt')::int < p_attempt
      -- 4. same attempt: anything except downgrading an answer to a miss
      or (
        (context -> 'reach' ->> 'attempt')::int = p_attempt
        and not (
          context -> 'reach' ->> 'status' = 'answered'
          and p_status = 'no_answer'
        )
      )
      -- 3. an older attempt matches none of the above, so it is ignored
    );

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Called by telnyx-voice-call-end with the service-role key. Revoke the
-- default PUBLIC grant and grant service_role explicitly, per the Data API
-- lockdown convention.
revoke execute on function public.record_reach_outcome(text, int, text, text)
  from public, anon, authenticated;
grant execute on function public.record_reach_outcome(text, int, text, text)
  to service_role;

comment on function public.record_reach_outcome is
  'Atomically record a reach-teammate B-leg outcome on the caller session, applying the same precedence as reachOutcomeShouldApply() so two concurrent webhooks cannot drop an "answered". Returns true when this call was the one that wrote.';
