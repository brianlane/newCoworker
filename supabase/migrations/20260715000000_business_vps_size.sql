-- Decouple VPS hardware size from plan tier.
--
-- `tier` remains the entitlement axis (minutes, SMS, concurrency, AI budget,
-- render). `vps_size` pins the Hostinger hardware SKU for this business:
--   kvm2  → hostingercom-vps-kvm2-* (2 vCPU / 8 GB)
--   kvm8  → hostingercom-vps-kvm8-* (8 vCPU / 32 GB)
--   NULL  → tier default (starter→kvm2, standard→kvm8) — preserves the
--           historical mapping so existing tenants keep their hardware until
--           an operator explicitly pins them.
--
-- Resolution helper lives in src/lib/vps/size.ts (resolveVpsSize).

alter table businesses
  add column if not exists vps_size text
  check (vps_size is null or vps_size in ('kvm2', 'kvm8'));

comment on column businesses.vps_size is
  'Hardware pin (kvm2|kvm8). NULL = tier default (starter→kvm2, standard→kvm8). Entitlements stay on tier.';
