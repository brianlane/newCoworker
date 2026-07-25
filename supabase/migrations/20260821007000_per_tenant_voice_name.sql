-- Per-tenant Gemini Live voice, live-applied.
--
-- The voice callers hear was previously settable ONLY through
-- `businesses.enterprise_models.voiceName`, which had two problems:
--   1. enterprise tier only (the admin card and the API both refuse other
--      tiers), so a standard-tier tenant could not change their voice at all;
--   2. it became box env at the next provision/redeploy, so every change
--      needed a redeploy of that tenant's box before anyone could hear it.
--
-- Neither fits a cosmetic brand choice that owners want to audition. This
-- column lives on the per-tenant VOICE settings table the bridge already reads
-- ONCE PER CALL (`loadTenantTelnyxSettings`), so a change applies to the next
-- call with no redeploy and no new query.
--
-- NULL means "no tenant choice": the bridge falls back to the box's VOICE_NAME
-- env (legacy plus an ops escape hatch) and then to the platform default,
-- `Kore`. Before this, an unset voice meant whatever Google's Live API happened
-- to default to, which is undocumented per model and which Google explicitly
-- warns can change: two boxes with identical config were observed answering in
-- different voices.
--
-- The CHECK mirrors GEMINI_LIVE_VOICES in src/lib/plans/enterprise-models.ts
-- (Gemini Live's 30 prebuilt voices); tests/voice-name-lockstep.test.ts pins the
-- two lists equal so widening the set later cannot half-land.
--
-- No grant statement: adding a column to an existing table inherits the table's
-- grants (same as 20260821004000_voice_translator_mode.sql).

alter table business_telnyx_settings
  add column if not exists voice_name text null;

alter table business_telnyx_settings
  drop constraint if exists business_telnyx_settings_voice_name_chk;
alter table business_telnyx_settings
  add constraint business_telnyx_settings_voice_name_chk
  check (
    voice_name is null or voice_name in (
      'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede',
      'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome',
      'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda',
      'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager',
      'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi'
    )
  );

comment on column business_telnyx_settings.voice_name is
  'Gemini Live prebuilt voice for this tenant''s calls. NULL = platform default (Kore). Live-applied: read per call by the voice bridge, so a change needs no redeploy.';
