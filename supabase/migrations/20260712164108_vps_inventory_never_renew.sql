-- vps_inventory.never_renew — a sunk-cost box that must lapse at its paid
-- period end NO MATTER WHAT, even while assigned to a live tenant.
--
-- Motivation (Jul 2026): srv1632631 is KVM8 hardware pooled under the kvm2
-- label so a normal standard signup can consume the already-paid box before
-- it lapses Jul 30. If a tenant adopts it, the platform must NOT start paying
-- the $73.99/mo KVM8 renewal for a kvm2-priced tenant. Two automated systems
-- would otherwise flip renewal back on; this flag makes the intent
-- machine-readable for both:
--   * the adopt path (src/lib/hostinger/adopt.ts) skips its best-effort
--     auto-renew re-enable and logs the migration deadline instead;
--   * the daily billing-posture cron (src/lib/vps/billing-posture.ts) skips
--     the tenant-direction auto-heal and emails ops a migration-needed
--     finding every run until the tenant is moved to its correct size
--     (debug/migrate-vps-size.ts), which itself adopts-first from the pool.
alter table public.vps_inventory
  add column if not exists never_renew boolean not null default false;

comment on column public.vps_inventory.never_renew is
  'Never re-enable Hostinger auto-renew for this box — it lapses at its paid period end no matter what. A tenant adopted onto it must be migrated to its correct size before then (the posture cron nags daily).';

-- srv1632631: KVM8 hardware pooled as kvm2 (see PRDs/tier-economics-jul-2026.md,
-- Fleet & constraints); must lapse at the Jul 30 2026 period end whether or
-- not a signup adopts it first.
update public.vps_inventory set never_renew = true where vm_id = 1632631;
