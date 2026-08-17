-- Telnyx outbound-capacity admin alerts: audit rows + race-proof claim.
--
-- Context (2026-08-16 incident): the fleet shares one Telnyx connection and
-- outbound voice profile, and a dial that exceeds the carrier's concurrent
-- channel limit is rejected at POST /v2/calls with HTTP 403. No leg, no CDR,
-- no webhook: the only trace was a telemetry row nothing reads, and we
-- learned about it from a Telnyx email. telnyx-voice-originate now classifies
-- that rejection and emails the platform admin, deduped through this table so
-- a morning burst of rejections produces ONE email, not one per dial.
--
-- Claim-before-send, delete-to-release: same pattern as
-- chat_spend_velocity_alerts (20260711002041). The unique index on
-- alert_bucket makes the claim atomic FLEET-WIDE (deliberately not per
-- business: the carrier pool is shared, so one email per bucket covers every
-- tenant it starved; the row still records which dial tripped it first).

create table if not exists voice_capacity_alerts (
  id bigint generated always as identity primary key,
  business_id uuid references businesses(id) on delete set null,
  flow_id uuid,
  telnyx_code text,
  http_status int,
  -- now() truncated to the bucket length (60 min in the caller). Unique, so
  -- two concurrent originate invocations cannot both send.
  alert_bucket timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_voice_capacity_alerts_bucket
  on voice_capacity_alerts (alert_bucket);

create index if not exists idx_voice_capacity_alerts_created
  on voice_capacity_alerts (created_at desc);

alter table voice_capacity_alerts enable row level security;

comment on table voice_capacity_alerts is
  'Sent Telnyx outbound-capacity admin alerts (audit + fleet-wide per-bucket dedupe; alert_bucket unique index makes claims race-proof). RLS on, no policies: service-role only.';

grant select, insert, delete on table voice_capacity_alerts to service_role;

-- Atomic claim: insert-or-nothing on the alert_bucket unique index. Returns
-- the claimed row id, or NULL when another invocation already holds the
-- bucket. The caller deletes the row on a send failure so the next capacity
-- rejection retries the email instead of silently dropping it.
create or replace function voice_capacity_try_claim_alert(
  p_business_id uuid,
  p_flow_id uuid,
  p_telnyx_code text,
  p_http_status int,
  p_bucket_minutes int
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
    business_id, flow_id, telnyx_code, http_status, alert_bucket
  )
  values (p_business_id, p_flow_id, p_telnyx_code, p_http_status, v_bucket)
  on conflict (alert_bucket) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function voice_capacity_try_claim_alert is
  'Race-proof Telnyx capacity alert claim: one row per fleet-wide time bucket. NULL = another invocation already claimed this bucket (or a non-positive bucket length).';

revoke all on function voice_capacity_try_claim_alert(uuid, uuid, text, int, int) from public;
grant execute on function voice_capacity_try_claim_alert(uuid, uuid, text, int, int) to service_role;
