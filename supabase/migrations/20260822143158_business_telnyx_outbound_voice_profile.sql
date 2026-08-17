-- Per-tenant Telnyx outbound voice profile id, part 3 of the capacity plan.
--
-- Until now the fleet shared ONE Call Control Application and ONE outbound
-- voice profile: business_telnyx_settings.telnyx_connection_id existed per
-- tenant but cached the single platform value, and the profile id was stored
-- nowhere at all (only discoverable by listing the account). Provisioning now
-- creates a DEDICATED app + profile per tenant, with the profile's
-- concurrent_call_limit and the app's channel_limit carrying the tenant's
-- plan promise ("up to 10 concurrent calls") at the carrier itself. This
-- column records which profile belongs to the tenant so limits can be synced
-- on tier changes, swept by the capacity monitor, and audited by
-- debug/telnyx-capacity.ts.
--
-- No table/function creation here, so no new Data API grants are needed:
-- business_telnyx_settings already carries its service-role grants.

alter table business_telnyx_settings
  add column if not exists telnyx_outbound_voice_profile_id text;

comment on column business_telnyx_settings.telnyx_outbound_voice_profile_id is
  'The tenant''s DEDICATED Telnyx outbound voice profile (per-tenant concurrent_call_limit + daily spend fuse + destination whitelist). Null = tenant still rides the shared platform profile; telnyx_connection_id then also holds the shared platform app id.';
