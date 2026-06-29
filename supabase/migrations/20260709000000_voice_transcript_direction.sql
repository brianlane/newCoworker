-- Voice call transcripts: record call direction (inbound vs outbound) so the
-- owner dashboard can tag each call.
--
-- The VPS bridge sets this on transcript creation: an outbound AiFlow leg is
-- placed by telnyx-voice-originate, which writes a voice_handoff_sessions row
-- whose context carries `outbound: true`; the bridge reads that on connect and
-- records direction = 'outbound'. Every other call (a customer dialing the
-- business DID) is 'inbound', which is also the safe default for legacy rows.

alter table voice_call_transcripts
  add column if not exists direction text not null default 'inbound'
    check (direction in ('inbound', 'outbound'));

-- Backfill historical rows: any transcript whose leg was placed by an outbound
-- flow has a voice_handoff_sessions row with context->>'outbound' = 'true'.
-- Everything else stays 'inbound' (the column default).
update voice_call_transcripts t
set direction = 'outbound'
from voice_handoff_sessions s
where s.call_control_id = t.call_control_id
  and coalesce((s.context ->> 'outbound')::boolean, false) = true
  and t.direction <> 'outbound';
