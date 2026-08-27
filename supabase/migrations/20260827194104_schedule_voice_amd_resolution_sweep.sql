-- Schedule the voice-amd-resolution-sweep Edge function via pg_cron + pg_net.
--
-- WHY. Flow-placed outbound AI calls arm premium AMD, and a `machine`
-- verdict is PROVISIONAL: telnyx-voice-call-end stamps it and defers the
-- action (speak the configured voicemail, or hang up a scriptless leg) to a
-- greeting/screening resolution event. Telnyx stopped delivering greeting
-- events platform-wide on 2026-08-25 (memory
-- project_telnyx_premium_amd_event_collapse), so confirmed machine verdicts
-- stood unresolved forever and the deterministic voicemail path never ran.
-- The sweep is the bounded timeout that design was missing: a machine stamp
-- still unresolved 25s later is acted on through the same claim the
-- greeting handler and the model's voicemail_reached tool use.
--
-- CADENCE. Every 15 seconds (pg_cron second-granularity schedule), because
-- the actionable window inside a call is tens of seconds: mailbox recording
-- limits run 60-180s, and each 15s of delay is 15 more seconds of the
-- bridge improvising into the recording. The tick is nearly free: the job
-- body gates net.http_post on an EXISTS over the partial index below, so a
-- tick with no live machine-stamped leg runs one indexed lookup and makes
-- NO HTTP request. The fine-grained checks (grace age, claim state,
-- screening, rollout gate) live in the Edge function and its pure decision
-- module; this guard only has to be a superset of them, and deliberately
-- avoids casting jsonb timestamps in SQL so one malformed row can never
-- error the job for every future tick.
--
-- The sweep itself ships DARK: the Edge function acts only on businesses
-- named by the `voice_amd_resolution` row in admin_platform_settings, so
-- scheduling this job changes nothing until a tenant is enrolled.
--
-- Security model mirrors 20260822195628_schedule_call_integrity_sweep.sql:
-- Bearer secret + Edge base URL from Vault via public._cron_vault_read,
-- missing secrets fail safe (401, nothing runs).
--
-- timeout_milliseconds is 30000: the sweep does two indexed reads and at
-- most a handful of Telnyx calls, and pg_net enforces this in its
-- background worker (tests/cron-timeout-parity.test.ts; self-contained
-- function, no /api/internal route in the chain).
--
-- grants: none (schedule_voice_amd_resolution_sweep): schedules a pg_cron
-- job and creates an index; neither is a Data API object.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The EXISTS guard's (and the sweep query's) access path: live outbound AI
-- legs by recency. Partial on status so the index stays a few rows regardless
-- of how many finished sessions the table accumulates.
create index if not exists voice_handoff_sessions_ai_intake_created_idx
  on voice_handoff_sessions (created_at)
  where status = 'ai_intake';

do $unschedule$
begin
  perform cron.unschedule('edge-voice-amd-resolution-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-voice-amd-resolution-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-voice-amd-resolution-sweep',
  '15 seconds',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/voice-amd-resolution-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (
    select 1
      from voice_handoff_sessions
     where status = 'ai_intake'
       and created_at > now() - interval '30 minutes'
       and coalesce(context->>'machine_detected', '') = 'true'
       and coalesce(context->>'voicemail_claimed', '') <> 'true'
       and coalesce(context->>'voicemail_speak_started_at', '') = ''
       and coalesce(context->>'amd_resolution_hung_up', '') <> 'true'
  );
  $$
);
