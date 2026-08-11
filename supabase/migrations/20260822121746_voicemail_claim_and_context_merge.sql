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
     set context = coalesce(context, '{}'::jsonb) || '{"voicemail_spoken": true}'::jsonb
   where call_control_id = p_call_control_id
     and coalesce(context->>'voicemail_spoken', '') <> 'true'
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

-- Releasing the claim is how a FAILED speak avoids reporting a message that was
-- never left: without it the run would resolve `voicemail_left` on a leg where
-- nothing was said.
create or replace function public.voice_release_voicemail_claim(
  p_call_control_id text
)
returns void
language sql
security definer
set search_path = public
as $$
  update voice_handoff_sessions
     set context = coalesce(context, '{}'::jsonb) - 'voicemail_spoken'
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
