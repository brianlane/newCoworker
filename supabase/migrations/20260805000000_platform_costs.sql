-- Platform cost sync tables (admin Costs/Usage views).
--
-- The tier-economics canvases were built from a one-shot pull
-- (debug/pull-cost-data.ts): Telnyx /v2/detail_records invoice actuals and
-- the Hostinger billing-subscription list. These two tables persist that
-- pull as a daily cron sync so the admin panel can show vendor costs and
-- per-tenant margin without visiting external dashboards.
--
-- Access: service-role only (RLS on, no policies) via
-- src/lib/db/platform-costs.ts. Nothing bills from these rows — they are
-- operator-facing cost telemetry.

-- Telnyx message/voice detail records, aggregated per UTC day, tenant,
-- record type, and direction. `business_id` is NULL for records whose
-- cli/cld matched no tenant DID (platform-level or leaked spend — the
-- costs page surfaces that bucket as a leak detector).
--
-- Idempotency is delete+insert over the synced rolling window (Telnyx only
-- accepts preset last_7/30/90-day ranges), NOT upsert: business_id is
-- nullable, so a plain unique constraint can't key the conflict.
create table if not exists public.telnyx_cost_daily (
  id bigint generated always as identity primary key,
  day date not null,
  -- ON DELETE SET NULL: a deleted business's historical cost stays in the
  -- vendor totals, just unattributed.
  business_id uuid references public.businesses(id) on delete set null,
  -- Telnyx MDR record_type: 'messaging' (SMS/MMS) | 'sip-trunking' (voice legs).
  record_type text not null check (record_type in ('messaging', 'sip-trunking')),
  direction text not null,
  record_count integer not null default 0,
  -- Micro-USD (1e-6 USD) so fractional per-message costs survive integer storage.
  cost_micros bigint not null default 0,
  carrier_fee_micros bigint not null default 0,
  billed_seconds bigint not null default 0,
  synced_at timestamptz not null default now()
);

create index if not exists idx_telnyx_cost_daily_day
  on public.telnyx_cost_daily (day desc);
create index if not exists idx_telnyx_cost_daily_business
  on public.telnyx_cost_daily (business_id, day desc);

alter table public.telnyx_cost_daily enable row level security;
-- No policies on purpose: anon/authenticated get zero access; the service
-- role bypasses RLS. Same posture as vps_inventory.

-- Hostinger billing-subscription snapshot (full replace on every sync).
-- One row per KVM billing subscription, joined to its VM and (when a live
-- tenant points at that VM) the owning business.
create table if not exists public.hostinger_vps_costs (
  subscription_id text primary key,
  vm_id bigint,
  hostname text,
  -- Plan label as Hostinger returns it, e.g. 'KVM 2'.
  plan text,
  -- e.g. 'active', 'non_renewing', 'cancelled' (live API, Jul 2026).
  status text not null,
  billing_period integer,
  billing_period_unit text,
  total_price_cents integer,
  renewal_price_cents integer,
  -- Renewal price normalized to effective cents/month (term length divided out).
  monthly_price_cents integer,
  is_auto_renewed boolean,
  next_billing_at timestamptz,
  expires_at timestamptz,
  -- ON DELETE SET NULL: a deleted business must not take the cost row down.
  assigned_business_id uuid references public.businesses(id) on delete set null,
  snapshot_at timestamptz not null default now()
);

create index if not exists idx_hostinger_vps_costs_business
  on public.hostinger_vps_costs (assigned_business_id);

alter table public.hostinger_vps_costs enable row level security;
-- No policies on purpose (service-role only), matching telnyx_cost_daily.
