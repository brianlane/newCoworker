-- Record WHO marked a notification read.
--
-- `markNotificationRead` keyed on business_id alone and recorded no actor,
-- and admin view-as has full tenant access (only the legal/consent accept is
-- refused). So a support session opening a tenant's notifications stamped
-- read_at in a way that is byte-identical to the owner doing it.
--
-- That was harmless while nothing read the stamp. It stops being harmless
-- the moment read_at becomes evidence that a human is still receiving our
-- alerts, which is exactly what the channel-liveness check makes it: without
-- an actor, the check can be satisfied by the very investigation that opened
-- it. On KYP Ads the only thing keeping the tenant off "dark" was a
-- dashboard read a few days old, and we could not prove it was the owner
-- rather than us.
--
-- Three values, deliberately coarse. This is an ATTRIBUTION column, not an
-- audit trail: the question is only "does this stamp count as the audience
-- being alive", and storing a user id here would put an identifiable actor
-- on every row of a table the tenant can read through RLS for no gain.
--   'owner'  a signed-in tenant session marked it read
--   'admin'  a platform admin did, including view-as  (never counts)
--   'system' a background path did (digest, retention, backfill)
-- NULL is every row written before this migration, and stays NULL forever:
-- unknown is a third state, and collapsing it into 'owner' would launder the
-- exact false confidence this column exists to remove.
--
-- grants: none (notification_read_actor): adds a column to an existing
-- table, creates no object. notifications already carries its own grants.

alter table public.notifications
  add column if not exists read_by_actor text;

alter table public.notifications
  drop constraint if exists notifications_read_by_actor_check;

alter table public.notifications
  add constraint notifications_read_by_actor_check
  check (read_by_actor is null or read_by_actor in ('owner', 'admin', 'system'));

comment on column public.notifications.read_by_actor is
  'Who stamped read_at: owner | admin | system. NULL for rows read before 20260828183414, which stay unattributed forever. The channel-liveness check counts only ''owner'' as proof the alert audience is alive, and discards ''admin'' outright so a support view-as session cannot vouch for the customer.';

-- The liveness read is "newest non-admin read for this business", which is a
-- filtered ORDER BY read_at DESC LIMIT 1 per tenant, once a day. Partial on
-- read_at IS NOT NULL because unread rows are the overwhelming majority and
-- can never satisfy the query.
create index if not exists notifications_business_read_at_idx
  on public.notifications (business_id, read_at desc)
  where read_at is not null;
