-- vps_inventory.expires_at — Hostinger paid-through timestamp for pool
-- ranking. Sourced from the billing subscription's expires_at (non_renewing)
-- or next_billing_at (active/renewing). The adopt-first claim picks the
-- furthest-expiry available box of the requested size and refuses candidates
-- with under 72h of runway (falls through to purchase instead of landing a
-- tenant on a box that dies the next day). The daily billing-posture cron
-- refreshes this column for every non-retired row.
--
-- Backfill: Amy's old kvm2 (1800980) is known to lapse 2026-08-02 from the
-- Hostinger billing subscription 6olCmVOFdCdH2ONv; other rows stay null until
-- the next posture refresh.

alter table if exists public.vps_inventory
  add column if not exists expires_at timestamptz null;

do $$
begin
  if to_regclass('public.vps_inventory') is not null then
    comment on column public.vps_inventory.expires_at is
      'Hostinger paid-through (expires_at ?? next_billing_at). Used by claimAvailableVps to prefer the furthest-expiry pooled box and skip candidates with under 72h of runway.';

    update public.vps_inventory
      set expires_at = '2026-08-02T20:51:19Z'
      where vm_id = 1800980 and expires_at is null;
  end if;
end $$;
