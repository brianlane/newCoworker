-- Let notification_link_clicks hold a Web Push tap.
--
-- 20260828183415 created this table for exactly one purpose: record the owner
-- click we already collect and throw away, because it "proves a specific
-- human opened a specific alert that arrived on a specific channel". Its
-- `channel` column exists, in its own words, "so the liveness read can filter
-- by channel from the start rather than assuming". Push is the second
-- occupant that column was anticipating, and the strongest one: a
-- notificationclick fires on the owner's own device, from a real gesture, on
-- a subscription bound to an authenticated user row.
--
-- TWO SHAPES WERE REJECTED before this one.
--
--   A separate push_receipts table. It duplicates business_id / clicked_at /
--   channel, forces the liveness read to become two functions that can
--   disagree about what a human signal is, and opens a second erasure
--   surface for no gain.
--
--   Stamping notifications.read_at with read_by_actor = 'push'. Tempting,
--   since a tap genuinely IS a read. It is wrong in the exact way this check
--   has already been burned once: lastDashboardReadAt reads the newest
--   non-admin read_at across the tenant, so a push tap would certify the
--   DASHBOARD as live. That is the WhatsApp-lead bug repeated one channel
--   over. (The receipt route still marks the notification read, which is
--   correct and separate; what it must not do is let that be the dashboard's
--   liveness evidence.)
--
-- link_id becomes nullable because a push tap has no sms_links row: there is
-- no shortened URL in the chain at all. The CHECK below keeps the original
-- invariant intact for the channel that does have one, so an SMS row still
-- cannot be written without its link.

alter table public.notification_link_clicks
  alter column link_id drop not null;

-- The notifications row this tap was about, so a receipt can be attributed to
-- one alert rather than to "something, recently".
--
-- A BARE uuid WITH NO FOREIGN KEY, deliberately. `notifications` is in
-- RESIDENCY_MOVED_TABLES, so for a dual/vps tenant the row this points at may
-- live on the tenant's own box and have been purged centrally. A central FK
-- would refuse the insert exactly when the tenant is most configured, and a
-- cascade would be meaningless besides.
alter table public.notification_link_clicks
  add column if not exists notification_id uuid;

alter table public.notification_link_clicks
  drop constraint if exists notification_link_clicks_sms_needs_link_check;
alter table public.notification_link_clicks
  add constraint notification_link_clicks_sms_needs_link_check
  check (channel <> 'sms' or link_id is not null);

comment on column public.notification_link_clicks.link_id is
  'The sms_links row whose redirect was clicked. NULL for channels that carry no shortened link (push), enforced per-channel by notification_link_clicks_sms_needs_link_check.';
comment on column public.notification_link_clicks.notification_id is
  'The notifications row the tap was about. No FK on purpose: notifications is residency-moved, so this id may name a row that lives on the tenant box and is purged centrally.';

-- grants: none (notification_link_clicks): alters an existing table that
-- already grants select/insert/update/delete to service_role at
-- 20260828183415; no new object is created here.
