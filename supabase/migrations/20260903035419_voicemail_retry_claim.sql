-- Claim the right to re-issue a cancelled or implausibly short voicemail speak,
-- exactly once per leg.
--
-- The first speak is gated by voice_claim_voicemail_speak. A cancelled_amd
-- retry cannot use that claim: it already holds it, so re-claiming would
-- return false and never re-speak. Skipping the claim entirely is also wrong:
-- Telnyx delivers call.speak.ended at-least-once, and two in-flight handlers
-- would both pass "not yet restarted" and talk over each other into the
-- mailbox.
--
-- Same compare-and-set shape as the first claim. Returns true only for the
-- caller that flipped voicemail_speak_restarted.

create or replace function public.voice_claim_voicemail_retry(
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
     set context = coalesce(context, '{}'::jsonb)
                  || '{"voicemail_speak_restarted": true}'::jsonb
   where call_control_id = p_call_control_id
     and coalesce(context->>'voicemail_claimed', '') = 'true'
     and coalesce(context->>'voicemail_speak_restarted', '') <> 'true'
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.voice_claim_voicemail_retry(text) from public, anon, authenticated;
grant execute on function public.voice_claim_voicemail_retry(text) to service_role;
