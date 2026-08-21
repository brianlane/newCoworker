-- Host CPU/memory metrics alongside the security-posture checks.
--
-- The posture report already carries memory headroom, but as a BOOLEAN check
-- against an 8%-or-300MiB floor with the number buried in a prose detail
-- string ("4485 MiB available (56%), swap 15/4095 MiB used"). That shape is
-- right for posture (any failed check marks the report as drift and emits
-- vps_posture_drift), and useless as a time series: you cannot trend a
-- sentence, and a busy box is not a security finding.
--
-- CPU was not collected at all, which is the bigger gap. The load a tenant
-- box actually carries is the only honest input to "is this box too small",
-- and the hardware-escalation advisor has been inferring it from billing
-- entitlements instead: it fires on voice minutes as a fraction of the
-- INCLUDED pool, which measures a Stripe plan, not a machine. Reloadable
-- packs make that reading actively wrong, since a tenant can buy past the
-- pool without touching hardware.
--
-- So: a nullable jsonb sidecar, written by heartbeat.sh, aggregated across
-- the 2-minute cron ticks between hourly posture reports (roughly 30 samples
-- per report, not one instantaneous reading that would miss every burst).
-- Nullable because boxes report before they are redeployed with the new
-- heartbeat, and an old box must keep reporting posture normally.
--
-- No new object, so no new Data API grants: vps_posture_reports already
-- exists as a service-role-only table (RLS on, zero policies) and a column
-- inherits the table's privileges.

alter table public.vps_posture_reports
  add column if not exists metrics jsonb;

comment on column public.vps_posture_reports.metrics is
  'Host CPU/memory sample aggregate for the interval since the previous report (cpuCount, load1Max/Mean, memAvailableMinMib, memTotalMib, swapUsedMaxMib, samples). Null on boxes running a heartbeat that predates the metrics block.';
