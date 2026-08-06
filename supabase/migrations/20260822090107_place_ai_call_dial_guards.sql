-- Per-lead dial cap for outbound AI calls.
--
-- voice_outbound_dial_log already guarantees each (flow, occurrence) dials at
-- most once, which stops a crashed worker from re-ringing the same person for
-- the same step. It cannot stop the other shape: two DIFFERENT flows, or a
-- re-triggered run, both dialing the same lead within minutes. Amy Laidlaw's
-- account is the live example, where a seller-lead flow and a weekly
-- follow-up flow can both hold the same number.
--
-- Counting that needs the callee on the row, which the table never stored:
-- its only question until now was "did THIS occurrence dial?". Nullable and
-- backfill-free on purpose, since existing rows predate the cap and a null
-- simply does not count toward it.
--
-- grants: none (voice_outbound_dial_log): the table already exists with its
-- own policies and service_role grants; adding a column does not change its
-- Data API exposure.

alter table public.voice_outbound_dial_log
  add column if not exists to_e164 text;

-- Supports the cap's only query: "how many times has this business dialed
-- THIS number since <cutoff>". business_id leads because every read is
-- already tenant-scoped, and created_at descends so the window scan stops
-- early instead of walking a tenant's whole dial history.
create index if not exists idx_voice_outbound_dial_log_to_e164
  on public.voice_outbound_dial_log (business_id, to_e164, created_at desc);

comment on column public.voice_outbound_dial_log.to_e164 is
  'Callee for this dial, counted by the per-lead cap in _shared/ai_flows/call_guards.ts. Null on rows written before the cap existed and on refusals that never resolved a number; both simply do not count toward it.';
