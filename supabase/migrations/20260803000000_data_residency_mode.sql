-- Per-tenant data-residency mode (enterprise-only, opt-in feature).
--
-- Gates the VPS-local data-residency program: an enterprise tenant's
-- customer content (contacts, conversations, transcripts, memories) can be
-- moved onto their own VPS behind a per-tenant data API. The mode drives
-- which store the app/Edge read and write:
--
--   'supabase' (default) — all content in central Supabase; the code path
--                          is byte-identical to pre-residency behavior.
--   'dual'               — write both stores (Supabase remains source of
--                          truth) while a tenant is being migrated.
--   'vps'                — the tenant's box is the source of truth; reads
--                          go through the tunnel data API.
--
-- The flag is settable ONLY for tier='enterprise' businesses; the app
-- enforces that at every write site (src/lib/residency/tier-gate.ts) — the
-- column itself stays tier-agnostic so a future tier expansion is a code
-- change, not a migration.

alter table public.businesses
  add column if not exists data_residency_mode text not null default 'supabase';

alter table public.businesses
  drop constraint if exists businesses_data_residency_mode_check;

alter table public.businesses
  add constraint businesses_data_residency_mode_check
  check (data_residency_mode in ('supabase', 'dual', 'vps'));

comment on column public.businesses.data_residency_mode is
  'Enterprise-only residency rollout gate: supabase (default) | dual (migrating, both stores written) | vps (tenant box is source of truth).';
