-- Atomic writes to voice_handoff_sessions.context for the answering-machine path.
--
-- Both functions here exist because read-modify-write on a jsonb column loses
-- races, and this particular column is written by two webhook handlers that can
-- be delivered concurrently (call.machine.*.detection.ended and
-- call.machine.*.greeting.ended, plus Telnyx's own at-least-once redelivery).
--
-- Two concrete failures they prevent:
--
--   1. A late `machine_detected` write, built from a context read BEFORE the
--      voicemail was spoken, clobbers `voicemail_spoken`. call.speak.ended then
--      declines to hang up and the run resolves `voicemail_no_message` after a
--      message was actually left.
--   2. Two deliveries both pass a check-then-speak guard and the AI speaks
--      twice into one recording, talking over itself.
--
-- `|| ` merges at the top level, which is all this needs: every key involved is
-- a scalar directly under `context`.

-- Merge a patch into a session's context in ONE statement. Concurrent merges of
-- DIFFERENT keys both survive; the row lock serializes them.
create or replace function public.voice_session_context_merge(
  p_call_control_id text,
  p_patch jsonb
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  update voice_handoff_sessions
     set context = coalesce(context, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb)
   where call_control_id = p_call_control_id
  returning context;
$$;

-- Claim the right to speak a voicemail, exactly once per leg.
--
-- Compare-and-set rather than check-then-act: the WHERE clause is what makes
-- the claim exclusive, so the winner is decided by the database rather than by
-- the order two handlers happened to read in. Returns true only for the caller
-- that flipped it, and that caller is the only one that speaks.
--
-- The claim key is deliberately NOT `voicemail_spoken`. Claiming happens before
-- the stream stop and the speak, and a leg can die in that window (the
-- voicemail system drops, the assistant ends the call). Reusing one key would
-- let the hangup path resolve the run `voicemail_left` for a message nobody
-- ever heard. `voicemail_spoken` is written separately, AFTER the speak
-- returns, and is the only key the outcome is derived from.
create or replace function public.voice_claim_voicemail_speak(
  p_call_control_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  update voice_handoff_sessions
     set context = coalesce(context, '{}'::jsonb) || '{"voicemail_claimed": true}'::jsonb
   where call_control_id = p_call_control_id
     and coalesce(context->>'voicemail_claimed', '') <> 'true'
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

-- Releasing the claim lets a retry delivery try again after a failed attempt.
-- It clears only the claim: `voicemail_spoken` is never set unless a speak
-- actually succeeded, so a released leg has nothing to unsay.
create or replace function public.voice_release_voicemail_claim(
  p_call_control_id text
)
returns void
language sql
security definer
set search_path = public
as $$
  update voice_handoff_sessions
     set context = coalesce(context, '{}'::jsonb) - 'voicemail_claimed'
   where call_control_id = p_call_control_id;
$$;

-- Data API grants. These are called by edge functions with the service role;
-- nothing client-side has any business flipping a call's voicemail state.
revoke all on function public.voice_session_context_merge(text, jsonb) from public, anon, authenticated;
revoke all on function public.voice_claim_voicemail_speak(text) from public, anon, authenticated;
revoke all on function public.voice_release_voicemail_claim(text) from public, anon, authenticated;
grant execute on function public.voice_session_context_merge(text, jsonb) to service_role;
grant execute on function public.voice_claim_voicemail_speak(text) to service_role;
grant execute on function public.voice_release_voicemail_claim(text) to service_role;
