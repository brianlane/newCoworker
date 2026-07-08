-- VPS provider axis (enterprise BYOS + Canada residency, PR 1).
--
-- Historically every tenant box was a Hostinger purchase, so "which provider
-- runs this box" was implicit. Two new enterprise-only hosting options make
-- it explicit:
--
--   'hostinger' (default) — platform-purchased Hostinger box (US fleet).
--                           Lifecycle: purchase/adopt, vps_inventory pool,
--                           Hostinger billing auto-renew, hPanel deletion.
--   'ovh'                 — platform-purchased OVHcloud box (Beauharnois,
--                           Quebec) for Canadian data residency. No Hostinger
--                           lifecycle; OVH service termination instead.
--   'byos'                — customer-owned box enrolled via SSH handover.
--                           No purchase, no pool, no provider billing; cancel
--                           runs an on-box wipe instead of a VM teardown.
--
-- The region axis records WHERE the box physically lives ('us' | 'ca') for
-- the data-residency compliance story (PIPEDA / Quebec Law 25: content at
-- rest in Canada with documented cross-border processing).
--
-- Like data_residency_mode, the columns stay tier-agnostic — the
-- enterprise-only gate for non-hostinger providers is enforced in code
-- (src/lib/vps/provider.ts) so a future tier expansion is a code change,
-- not a migration.

alter table public.businesses
  add column if not exists vps_provider text not null default 'hostinger';

alter table public.businesses
  drop constraint if exists businesses_vps_provider_check;

alter table public.businesses
  add constraint businesses_vps_provider_check
  check (vps_provider in ('hostinger', 'ovh', 'byos'));

alter table public.businesses
  add column if not exists vps_region text not null default 'us';

alter table public.businesses
  drop constraint if exists businesses_vps_region_check;

alter table public.businesses
  add constraint businesses_vps_region_check
  check (vps_region in ('us', 'ca'));

comment on column public.businesses.vps_provider is
  'Which provider runs the tenant box: hostinger (default, platform fleet) | ovh (platform-owned, Canada) | byos (customer-owned, SSH handover). Non-hostinger is enterprise-only, enforced in src/lib/vps/provider.ts.';
comment on column public.businesses.vps_region is
  'Physical region of the tenant box: us (default) | ca (Canadian data residency).';

-- Mirror the axis onto the per-box SSH key rows. `hostinger_vps_id` stays
-- the generic provider box id (Hostinger numeric VM id as text, OVH service
-- name, or a `byos-<businessId>` sentinel) — renaming the column would churn
-- every call site for zero behavior change.
alter table public.vps_ssh_keys
  add column if not exists provider text not null default 'hostinger';

alter table public.vps_ssh_keys
  drop constraint if exists vps_ssh_keys_provider_check;

alter table public.vps_ssh_keys
  add constraint vps_ssh_keys_provider_check
  check (provider in ('hostinger', 'ovh', 'byos'));

alter table public.vps_ssh_keys
  add column if not exists region text not null default 'us';

alter table public.vps_ssh_keys
  drop constraint if exists vps_ssh_keys_region_check;

alter table public.vps_ssh_keys
  add constraint vps_ssh_keys_region_check
  check (region in ('us', 'ca'));

-- Public IP / hostname of the box for providers with no live IP-lookup API
-- path (BYOS boxes are enrolled with an operator-entered host; OVH boxes
-- persist the delivered IP). NULL for Hostinger rows — their IP is looked
-- up live from the Hostinger API at use time, as before.
alter table public.vps_ssh_keys
  add column if not exists host text;

comment on column public.vps_ssh_keys.provider is
  'Provider that runs the box this key opens: hostinger | ovh | byos. Keep in lockstep with businesses.vps_provider.';
comment on column public.vps_ssh_keys.region is
  'Physical region of the box: us | ca.';
comment on column public.vps_ssh_keys.host is
  'Public IP/hostname for byos/ovh boxes (no live provider IP lookup). NULL for hostinger rows (IP resolved live from the Hostinger API).';
comment on column public.vps_ssh_keys.hostinger_vps_id is
  'Generic provider box id: Hostinger numeric VM id (text), OVH service name, or byos-<businessId> sentinel. Column name is historical.';
