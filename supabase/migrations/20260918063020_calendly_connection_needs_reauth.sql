-- Honest Calendly reconnect state.
--
-- A permanently rejected PAT (401/403) used to keep is_active=true, so the
-- dashboard pill stayed green and the poller kept presenting the dead
-- token. needs_reauth is a DISTINCT state from the owner's Disable toggle:
-- the row stays so Reconnect can write a new token onto the SAME connection
-- instead of stacking a duplicate, while listActive / the poller / the
-- booking-goal sweep skip it.
--
-- last_healthy_at is the last tick that successfully talked to Calendly
-- for this row (banner copy). reauth_email_count / reauth_email_last_sent_at
-- are the product-email cadence: once on the flip, once more after a day
-- if it is still broken, then stop.

alter table public.calendly_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_calendly_connections_needs_reauth
  on public.calendly_connections (business_id)
  where needs_reauth = true;

-- grants: none (column/index changes on an existing service-role-only table;
-- no new Data API objects).
