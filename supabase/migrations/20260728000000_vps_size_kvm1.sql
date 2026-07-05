-- KVM1 as a first-class hardware size (fleet economics Phase E → Phase C #4).
--
-- The Jul 2026 KVM1 smoke (VM 1806097) proved the starter stack fits on
-- 1 vCPU / 4GB with Gemini-only AI, so 'kvm1' becomes the starter tier's
-- default hardware. Widen the businesses.vps_size CHECK to accept it.
--
-- The original constraint was created inline by
-- 20260715000000_business_vps_size.sql, so its auto-generated name is
-- businesses_vps_size_check.

alter table public.businesses
  drop constraint if exists businesses_vps_size_check;

alter table public.businesses
  add constraint businesses_vps_size_check
  check (vps_size is null or vps_size in ('kvm1', 'kvm2', 'kvm8'));

comment on column public.businesses.vps_size is
  'Hardware pin (kvm1|kvm2|kvm8); null = tier default (starter→kvm1, standard→kvm8). kvm1 ships no local Ollama model — over-cap AI turns refuse instead of degrading.';
