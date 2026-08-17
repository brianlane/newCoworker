-- Weekly Telnyx capacity monitor, part 4 of the capacity plan.
--
-- The account-level outbound channel pool is the ONE limit Telnyx will not
-- expose or raise via API (support ticket only), so growth has to be watched
-- rather than automated. A weekly cron (voice-capacity-monitor) counts the
-- last 14 days of real capacity refusals (carrier 403s + platform_capacity
-- pre-dial blocks) and the fleet's committed per-tenant caps vs the granted
-- pool, and emails the admin a PRE-DRAFTED raise request when either says
-- the pool is getting tight.
--
-- Dedupe rides the same voice_capacity_alerts table as the incident alert
-- (PR #1403), which needs a second dimension: that table's unique index was
-- fleet-wide on alert_bucket alone, so a weekly monitor email in the same
-- hour bucket as an incident email would collide. A `kind` column splits
-- them; the claim RPC gains p_kind. The old 5-arg claim signature is
-- DROPPED FIRST (create or replace with an added parameter would leave a
-- PostgREST-ambiguous overload).

alter table voice_capacity_alerts
  add column if not exists kind text not null default 'carrier_rejection'
    check (kind in ('carrier_rejection', 'capacity_monitor'));

drop index if exists uq_voice_capacity_alerts_bucket;

create unique index if not exists uq_voice_capacity_alerts_kind_bucket
  on voice_capacity_alerts (kind, alert_bucket);

comment on column voice_capacity_alerts.kind is
  'carrier_rejection = the inline dial-time alert (60-min buckets); capacity_monitor = the weekly headroom review (week-long buckets). Split so the two alert streams cannot suppress each other in a shared bucket.';

drop function if exists public.voice_capacity_try_claim_alert(uuid, uuid, text, int, int);

create or replace function voice_capacity_try_claim_alert(
  p_business_id uuid,
  p_flow_id uuid,
  p_telnyx_code text,
  p_http_status int,
  p_bucket_minutes int,
  p_kind text default 'carrier_rejection'
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket timestamptz;
  v_id bigint;
begin
  if p_bucket_minutes is null or p_bucket_minutes < 1 then
    return null;
  end if;
  v_bucket := to_timestamp(
    floor(extract(epoch from now()) / (p_bucket_minutes * 60))::bigint
      * (p_bucket_minutes * 60)
  );
  insert into voice_capacity_alerts (
    business_id, flow_id, telnyx_code, http_status, alert_bucket, kind
  )
  values (
    p_business_id, p_flow_id, p_telnyx_code, p_http_status, v_bucket,
    coalesce(p_kind, 'carrier_rejection')
  )
  on conflict (kind, alert_bucket) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function voice_capacity_try_claim_alert is
  'Race-proof capacity alert claim: one row per (kind, time bucket). NULL = another invocation already claimed this bucket (or a non-positive bucket length). kind carrier_rejection = inline dial-time alerts; capacity_monitor = the weekly review.';

revoke all on function voice_capacity_try_claim_alert(uuid, uuid, text, int, int, text) from public;
grant execute on function voice_capacity_try_claim_alert(uuid, uuid, text, int, int, text) to service_role;

-- ---------------------------------------------------------------------
-- Schedule: Mondays 15:00 UTC (8 AM Phoenix), after the morning call
-- window has produced any fresh rejection telemetry. Same vault-read
-- security model as the other edge crons.
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-voice-capacity-monitor')
  where exists (
    select 1 from cron.job where jobname = 'edge-voice-capacity-monitor'
  );
end
$unschedule$;

select cron.schedule(
  'edge-voice-capacity-monitor',
  '0 15 * * 1',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/voice-capacity-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
