-- Claim the right to write the "[Voicemail]" transcript turn, exactly once per
-- leg. Same compare-and-set shape as voice_claim_voicemail_speak and for the
-- same reason: call.hangup is delivered at-least-once, and the handler that
-- decorates the transcript with the spoken voicemail (telnyx-voice-call-end)
-- would otherwise append one duplicate turn per redelivery. There is no unique
-- key on voice_call_transcript_turns to lean on, so the claim lives on the
-- session context, where the voicemail state already is.
--
-- No release counterpart on purpose. The speak claim needs one because a leg
-- can die between claiming and speaking, and a retry delivery must be able to
-- leave the message. Here the turn insert happens immediately after the claim
-- in the same handler; if that insert fails the transcript is merely missing a
-- cosmetic line, which is not worth reopening a race for.
create or replace function public.voice_claim_voicemail_turn(
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
     set context = coalesce(context, '{}'::jsonb) || '{"voicemail_turn_written": true}'::jsonb
   where call_control_id = p_call_control_id
     and coalesce(context->>'voicemail_turn_written', '') <> 'true'
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

-- Called by edge functions with the service role only.
revoke all on function public.voice_claim_voicemail_turn(text) from public, anon, authenticated;
grant execute on function public.voice_claim_voicemail_turn(text) to service_role;
