-- Per-tenant outbound dial headroom (owner policy, Aug 16 2026).
--
-- Each tenant's Telnyx app + profile now hard-cap that tenant at 10
-- concurrent outbound legs, and those 10 are shared by THREE leg kinds: AI
-- flow dials, warm transfers of live callers, and reach_teammate rings.
-- Only the AI dials are gated pre-dial; the other two fire mid-call and
-- must never find the tenant's own channels eaten by the AI. So AI flow
-- dials stop at (tenant cap - headroom), reserving channels per tenant for
-- the legs that carry a live human.
--
-- Null = platform default (3, TENANT_OUTBOUND_DIAL_HEADROOM_DEFAULT in
-- _shared/voice_reservation_limits.ts). Per-tenant override so an owner can
-- choose the consequence: a bigger reserve protects transfers harder, zero
-- lets the AI use every channel. Bounded 0..9 so at least one AI dial slot
-- always survives the subtraction.
--
-- Column on an existing granted table; no new grants needed.

alter table business_telnyx_settings
  add column if not exists voice_outbound_dial_headroom integer
    check (
      voice_outbound_dial_headroom is null
      or (voice_outbound_dial_headroom >= 0 and voice_outbound_dial_headroom <= 9)
    );

comment on column business_telnyx_settings.voice_outbound_dial_headroom is
  'Concurrent-call slots reserved OUT of this tenant''s cap for warm transfers and reach_teammate legs: AI flow dials defer once in-flight calls reach (cap - headroom). Null = platform default 3. Bounded 0..9 so one dial slot always remains.';
