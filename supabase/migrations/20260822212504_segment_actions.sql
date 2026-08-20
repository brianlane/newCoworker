-- ---------------------------------------------------------------------------
-- Smart List nightly actions: a saved segment can act.
--
-- A contact_segments row (Smart List) gains an optional nightly ACTION: when
-- action_enabled is true, the segment-action-sweep adds action_tag to every
-- contact currently matching the segment's filters that does not already
-- carry it. The tag lands through the shared contact-event path, so
-- tag_changed automations fire exactly as if a person added the tag in the
-- dashboard. last_applied_at records the sweep's most recent pass over the
-- segment (UI provenance, not a scheduling input: membership is evaluated
-- live every night).
--
-- Validation lives app-side (src/lib/segments/core.ts); the checks here are
-- the integrity floor: an enabled action always has a tag, and a stored tag
-- fits the contacts.tags 40-char entry cap.
--
-- No new objects are created (columns on an existing granted table plus a
-- cron schedule), so no new Data API grants are needed.
-- ---------------------------------------------------------------------------

alter table public.contact_segments
  add column if not exists action_tag text null,
  add column if not exists action_enabled boolean not null default false,
  add column if not exists last_applied_at timestamptz null;

alter table public.contact_segments
  add constraint contact_segments_action_tag_length check (
    action_tag is null or char_length(action_tag) between 1 and 40
  ),
  add constraint contact_segments_action_needs_tag check (
    not action_enabled or action_tag is not null
  );

comment on column public.contact_segments.action_tag is
  'Tag the nightly segment-action-sweep adds to matching contacts (via the shared tag_changed event path). Null = no action configured.';
comment on column public.contact_segments.action_enabled is
  'When true, the nightly sweep applies action_tag to matching contacts. Requires action_tag (see check constraint).';
comment on column public.contact_segments.last_applied_at is
  'When the segment-action-sweep last finished a pass over this segment. Provenance for the UI, not a scheduling input.';

-- ---------------------------------------------------------------------------
-- Schedule the sweep (mirrors 20260711221501_schedule_document_expiration_sweep):
-- nightly at 09:10 UTC, offset from the overnight sweeps (01:35 retention,
-- 02:05 documents, 02:50 analytics, 03:30 watchdog) and the top-of-hour
-- bursts. A day of drift is harmless: membership is evaluated live and
-- already-tagged contacts are skipped, so the sweep converges.
--
-- Call chain:
--   pg_cron -> net.http_post -> Edge `segment-action-sweep`
--                            -> Next.js POST /api/internal/segment-action-sweep
--
-- Security model mirrors 20260815000001_schedule_data_retention_sweep.sql:
-- Bearer from Vault (`internal_cron_secret`) via public._cron_vault_read,
-- Edge base URL from Vault (`edge_base_url`).
-- ---------------------------------------------------------------------------

do $unschedule$
begin
  perform cron.unschedule('edge-segment-action-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-segment-action-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-segment-action-sweep',
  '10 9 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/segment-action-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
