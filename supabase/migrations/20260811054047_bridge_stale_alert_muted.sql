-- Per-tenant mute for the voice_bridge_stale health alert.
--
-- Some internal tenants (e.g. the NCW Flow Test tenant) have a Telnyx DID +
-- connection wired up for SMS flow testing but deliberately run no VPS /
-- voice bridge, so the 5-minute health cron pages voice_bridge_stale forever.
-- This flag silences the stale-bridge alert for exactly one business without
-- touching the stuck-settlement check or any other tenant.
alter table business_telnyx_settings
  add column if not exists bridge_stale_alert_muted boolean not null default false;

comment on column business_telnyx_settings.bridge_stale_alert_muted is
  'When true, voice-bridge-health-alerts skips the stale-heartbeat alert for this business (intentional no-bridge tenants).';
