-- Record WHERE in a call's transcript the AI stopped being the receptionist and
-- became an interpreter.
--
-- Two things in the dashboard were wrong without it, both found investigating
-- Amy Laidlaw's call 5634b7f0 (2026-08-18):
--
--   1. The forwarded-call banner says "Only the conversation before the
--      transfer is transcribed below." On an interpreted call that is false:
--      the AI stays on the bridged line, so everything after the transfer is
--      transcribed too.
--   2. Those post-transfer turns are attributed to the CALLER, and they are not
--      reliably the caller. Telnyx's `both_tracks` fork carries the caller's
--      leg and the bridged leg, the voice bridge forwards both into one Gemini
--      input stream (it reads `media.payload` and ignores `media.track`), and
--      Gemini returns one undifferentiated `inputTranscription`. So after the
--      bridge, an inbound turn is EITHER human. On the incident call the owner
--      reads "Hello. Hello." as the lead when it was almost certainly the
--      teammate picking up.
--
-- Distinguishing the two humans properly would mean per-track diarization the
-- platform does not have today, so the UI stops claiming to know: from this
-- index onward it labels inbound turns as either party. Honest beats confident.
--
-- NULL means the AI never interpreted on this call, which is almost all of
-- them, so existing rows need no backfill.
alter table voice_call_transcripts
  add column if not exists interpreted_from_turn_index integer;

comment on column voice_call_transcripts.interpreted_from_turn_index is
  'Turn index from which the AI was interpreting between two humans on a bridged call, or NULL if it never was. From this index on, a caller-role turn may be either party: the both_tracks fork is not diarized.';

-- grants: none (voice_transcript_interpreted_from_turn): adds a column to an
-- existing table, whose Data API grants already stand. No new object.
