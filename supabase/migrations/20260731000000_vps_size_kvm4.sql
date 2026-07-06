-- KVM4 as a first-class hardware size (admin hardware-escalation ladder).
--
-- KVM4 (4 vCPU / 16GB) slots between the KVM2 default and the KVM8 heavy
-- box as the first escalation step for tenants with sustained load. Widen
-- the businesses.vps_size CHECK to accept it. Runtime behavior: kvm4
-- carries the qwen3:4b-instruct local fallback (deploy-client.sh's
-- non-kvm1/kvm2 branch), same as kvm8.
--
-- The constraint was last rewritten by 20260728000000_vps_size_kvm1.sql
-- under its auto-generated name businesses_vps_size_check.

alter table public.businesses
  drop constraint if exists businesses_vps_size_check;

alter table public.businesses
  add constraint businesses_vps_size_check
  check (vps_size is null or vps_size in ('kvm1', 'kvm2', 'kvm4', 'kvm8'));

comment on column public.businesses.vps_size is
  'Hardware pin (kvm1|kvm2|kvm4|kvm8); null = tier default. kvm1 ships no local Ollama model — over-cap AI turns refuse instead of degrading.';
