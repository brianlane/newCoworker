-- Continuous security-posture reports from tenant boxes (BYOS emphasis).
--
-- BYOS customers retain root on their own hardware, so the platform cannot
-- GUARANTEE posture the way it can on fleet boxes — it verifies instead:
-- the heartbeat cron gathers a posture snapshot (UFW active, sshd password
-- auth off, fail2ban running, unattended-upgrades installed, no unexpected
-- public listeners) and POSTs it to /api/vps/posture, authenticated by the
-- box's per-tenant gateway token. Drift surfaces on the admin business page
-- and as a `vps_posture_drift` telemetry event — it ALERTS, it does not
-- auto-pause (the customer has root; false positives are possible).
--
-- Fleet (Hostinger) boxes may also report; the data is equally useful there.

create table if not exists public.vps_posture_reports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- True when every reported check passed.
  ok boolean not null,
  -- Array of { name, ok, detail } objects, exactly as reported by the box.
  checks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_vps_posture_reports_business_created
  on public.vps_posture_reports (business_id, created_at desc);

alter table public.vps_posture_reports enable row level security;

-- Service-role only (RLS on, no policies) — same posture as vps_ssh_keys.
revoke all on table public.vps_posture_reports from public;
revoke all on table public.vps_posture_reports from anon;
revoke all on table public.vps_posture_reports from authenticated;

comment on table public.vps_posture_reports is
  'Per-box security posture snapshots reported by the heartbeat cron (gateway-token authenticated). Service-role only.';
