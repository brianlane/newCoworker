-- Live translator mode: keep the AI on the line as an interpreter after a
-- warm transfer, instead of removing its media fork.
--
-- Today `transfer_to_owner` bridges the caller to a human and the bridge then
-- issues streaming_stop so the two of them talk privately. When a caller and
-- the person picking up do not share a language, that is the moment the call
-- fails. With translator mode armed, the fork stays up with Telnyx's
-- `stream_bidirectional_target_legs=both`, so the AI hears both parties and is
-- audible to both, and interprets between them.
--
-- Off by default, per tenant. Arming it changes the ANSWER-time stream request
-- (the target-legs parameter has to be set before the legs are bridged), so it
-- is read on the inbound path, not decided mid-call.
--
-- Cost note, deliberate and owner-facing: an interpreted call meters BOTH legs
-- (the caller leg through AI settlement, the human leg through
-- voice_meter_forwarded_call) and runs Gemini Live for the whole human
-- conversation. The tenant pays for what they use; the UI says so where the
-- toggle lives.

alter table business_telnyx_settings
  add column if not exists translator_mode_enabled boolean not null default false;

comment on column business_telnyx_settings.translator_mode_enabled is
  'When true, the AI stays on a warm-transferred call as a live interpreter (Telnyx target_legs=both) instead of detaching. Off by default. Meters both call legs plus AI for the full conversation.';
