-- Multiple Calendly connections per business.
--
-- calendly_connections has been one-row-per-business since birth
-- (uq_calendly_connections_business), which models "the business's
-- Calendly" and breaks the moment a second person's bookings matter: KYP
-- Ads' second brand books on the assignee's own Calendly account, and the
-- single-PAT model cannot see those events at all (every read filters
-- /scheduled_events by the connected PAT's user URI). Same shape awaits
-- any tenant whose teammates book on personal Calendly accounts.
--
-- This migration relaxes the constraint to one row per (business, Calendly
-- ACCOUNT):
--   - the per-business unique index is dropped;
--   - identity dedupe moves to (business_id, user_uri), partial on
--     user_uri being known. The connect route resolves /users/me at verify
--     time and now persists user_uri immediately, so the index bites from
--     the first insert; legacy rows get theirs on the next poll resolve.
--
-- calendly_webhook_subscriptions follows: it was also unique per business,
-- but a subscription belongs to a CONNECTION (its signing key signs that
-- account's deliveries). Rows gain connection_id, backfilled through the
-- business's single pre-migration connection; uniqueness moves to
-- connection_id. business_id stays for the receiver's per-business lookup
-- (it now lists all of the business's subscriptions and verifies the
-- signature against each candidate key).

drop index if exists public.uq_calendly_connections_business;

create unique index if not exists uq_calendly_connections_business_user
  on public.calendly_connections (business_id, user_uri)
  where user_uri is not null;

alter table public.calendly_webhook_subscriptions
  add column if not exists connection_id uuid
    references public.calendly_connections(id) on delete cascade;

-- Every existing subscription belongs to its business's only connection
-- (both tables were unique per business until now).
update public.calendly_webhook_subscriptions s
set connection_id = c.id
from public.calendly_connections c
where c.business_id = s.business_id
  and s.connection_id is null;

-- A subscription row whose connection no longer exists is dead state (the
-- teardown path deletes rows with their connection, so these are strays):
-- drop them so connection_id can be NOT NULL and the upsert target below
-- can be a full unique index (PostgREST ON CONFLICT cannot use a partial).
delete from public.calendly_webhook_subscriptions where connection_id is null;

alter table public.calendly_webhook_subscriptions
  alter column connection_id set not null;

drop index if exists public.uq_calendly_webhook_subscriptions_business;

create unique index if not exists uq_calendly_webhook_subscriptions_connection
  on public.calendly_webhook_subscriptions (connection_id);

create index if not exists idx_calendly_webhook_subscriptions_business
  on public.calendly_webhook_subscriptions (business_id);

-- grants: none (index/column changes on existing service-role-only tables;
-- no new Data API objects).
