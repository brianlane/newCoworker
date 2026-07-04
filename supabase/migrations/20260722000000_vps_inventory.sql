-- VPS reuse pool (fleet economics Phase B).
--
-- Hostinger's refund policy (30 days per box AND >180 days since the last
-- VPS refund) means boxes we cancel or replace are sunk cost until at least
-- Dec 30, 2026. Instead of letting paid-for VMs idle until they lapse, this
-- table tracks them so provisioning can ADOPT an owned box (Hostinger setup /
-- recreate API — no purchase) before buying a new one.
--
-- States:
--   * available — owned, unassigned, adoptable by the next matching-size
--     provision. Auto-renew is typically OFF (Phase 0 decision: no renewal
--     spend to hold inventory), so an available box that reaches its paid
--     period end lapses; the adopt path verifies the VM still exists at
--     claim time and retires stale rows.
--   * assigned — currently backing a tenant business.
--   * retired  — gone from Hostinger (lapsed, panel-deleted, or refunded);
--     kept for audit instead of deleting the row.
--
-- Access: service-role only (RLS on, no policies) via src/lib/db/vps-inventory.ts.

create table if not exists public.vps_inventory (
  -- Hostinger's numeric virtual-machine id (srv<vm_id>.hstgr.cloud).
  vm_id bigint primary key,
  hostname text,
  -- Hardware SKU. kvm1/kvm4 are reserved for the Phase E experiments.
  plan text not null check (plan in ('kvm1', 'kvm2', 'kvm4', 'kvm8')),
  state text not null default 'available'
    check (state in ('available', 'assigned', 'retired')),
  hostinger_billing_subscription_id text,
  -- Set while state = 'assigned'. ON DELETE SET NULL: a deleted business must
  -- not take the inventory row (and its audit trail) down with it.
  assigned_business_id uuid references public.businesses(id) on delete set null,
  acquired_at timestamptz not null default now(),
  assigned_at timestamptz,
  notes text,
  updated_at timestamptz not null default now()
);

-- The adopt-first lookup: available boxes of a given size, oldest first.
create index if not exists idx_vps_inventory_state_plan
  on public.vps_inventory (state, plan);

alter table public.vps_inventory enable row level security;

-- No policies on purpose: anon/authenticated get zero access; the service
-- role bypasses RLS. Same posture as vps_ssh_keys.

-- Seed the pool with the box we already own and can't refund:
--   srv1800985 — bought Jul 2026 during the KVM2 experiments, never set up,
--   auto-renew off, paid through ~Aug 2 2026. (srv1800980 is deliberately
--   NOT seeded — it is reserved as Amy's cutover target; pool it manually
--   only if the cutover is aborted.)
insert into public.vps_inventory (vm_id, hostname, plan, state, notes)
values (
  1800985,
  'srv1800985.hstgr.cloud',
  'kvm2',
  'available',
  'KVM2 experiment leftover (Jul 2026). Refund window burned by the Jul 3 refunds; auto-renew off — lapses ~Aug 2, 2026 unless adopted first.'
)
on conflict (vm_id) do nothing;
