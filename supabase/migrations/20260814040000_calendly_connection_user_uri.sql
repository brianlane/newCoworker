-- Cache the connected Calendly account's canonical user URI on the direct
-- connection row.
--
-- The AiFlow calendar-trigger poller previously resolved it with a
-- GET /users/me on EVERY poll tick (~1/min per calendar-flow business,
-- ~1,440 Calendly calls/day) even though the URI is a constant for a given
-- PAT. Caching removes that per-tick call — and with it the dependency that
-- produced a false "calendar_not_connected" admin error when Calendly
-- momentarily 401'd the /users/me probe (KYP Ads, Jul 18).
--
-- Invalidation: a token update clears the cache (a new PAT can belong to a
-- different account); the next poll re-resolves and re-persists.

alter table public.calendly_connections
  add column if not exists user_uri text;

comment on column public.calendly_connections.user_uri is
  'Cached canonical Calendly user URI for the stored PAT (GET /users/me). Null until first resolve; cleared when the token changes.';
