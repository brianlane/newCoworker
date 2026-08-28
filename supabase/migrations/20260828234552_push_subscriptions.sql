-- Web Push device registrations: the first owner-alert channel we own.
--
-- WHY THIS EXISTS. Every alert channel we have is somebody else's surface.
-- SMS is metered and its carrier receipt only proves a handset ACKed, never
-- that a person read it. WhatsApp needs a pre-approved Meta template outside
-- the 24-hour service window (which is where owner alerts always land) and a
-- funded WABA. Email cannot be judged by replies at all. Slack needs a
-- workspace the business actually uses.
--
-- Push has none of those taxes, and one property none of them have: the
-- notificationclick handler in public/sw.js fires on the owner's own device
-- when the owner actually opens the alert. That is a REAL read receipt, not
-- an inferred one, which is why 20260828183415 (notification_link_clicks)
-- says an owner click "proves a specific human opened a specific alert that
-- arrived on a specific channel. Delivery receipts cannot make that claim,
-- and a reply cannot either."
--
-- SCOPE IS NULLABLE ON PURPOSE. business_id NULL means a platform-scoped HQ
-- admin device, which receives alert_delivery_failed and the liveness
-- sweep's alert_audience_dark rather than one tenant's alerts. A second
-- admin_push_subscriptions table was the obvious alternative and is worse:
-- one person can be an owner AND an HQ admin in the same browser, so the
-- same endpoint legitimately lives in both scopes and must dedupe within
-- each. Two tables cannot express "unique per scope" over a shared endpoint
-- space, and they would fork the 410-expiry hygiene into two code paths,
-- which is precisely the code that must never diverge.
--
-- RESIDENCY: CENTRAL, deliberately not in RESIDENCY_MOVED_TABLES. This is
-- engine state read by the Deno notifications worker at dispatch time, which
-- is the stated exclusion rule for moved tables. It is not tenant customer
-- content.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- NULL = platform/HQ-admin scope. See the header, and note the unique
  -- index below treats NULLs as equal so that scope dedupes like any other.
  business_id uuid references public.businesses(id) on delete cascade,
  -- auth.users id of the person whose browser this is. No FK, matching
  -- todos.created_by: deleting an auth user must not cascade away the record
  -- of which devices we were sending to.
  user_id uuid not null,
  -- RFC 8030 push service URL. Unbounded in the spec; the app caps it at
  -- 2048 and refuses any host outside the push-service allowlist in
  -- src/lib/push/subscription.ts (the server POSTs to this value, so an
  -- unvalidated endpoint is an SSRF hole).
  endpoint text not null,
  -- RFC 8291 client keys, base64url exactly as the browser hands them over.
  p256dh text not null,
  auth text not null,
  user_agent text,
  -- Coarse label for the "your devices" list ("iPhone Safari", "Chrome on
  -- Mac"). Derived from user_agent, stored so the list does not re-parse.
  device_label text,
  created_at timestamptz not null default now(),
  -- Refreshed whenever the browser re-presents this subscription. The
  -- staleness floor in listDeliverablePushSubscriptions reads it, as a
  -- backstop for any access-revocation path that forgets to revoke here.
  last_seen_at timestamptz not null default now(),
  last_sent_at timestamptz,
  revoked_at timestamptz,
  -- 'expired' is set inline when the push service answers 404/410, which is
  -- the only authoritative signal that a subscription is dead. A 403 is NOT
  -- an expiry: it means the VAPID key does not match, which a botched key
  -- rotation produces for the entire fleet at once, so treating it like a
  -- 410 would wipe every subscription we hold in a single dispatch.
  revoked_reason text
    check (revoked_reason is null or revoked_reason in ('user', 'expired', 'membership', 'account'))
);

-- One row per (scope, endpoint). NULLS NOT DISTINCT is load-bearing: without
-- it, NULL <> NULL means every HQ-admin re-subscribe from the same browser
-- INSERTS instead of updating, and one admin laptop grows rows without
-- bound. Requires Postgres 15+; production is 17.6 (verified 2026-08-28).
create unique index if not exists push_subscriptions_scope_endpoint_key
  on public.push_subscriptions (business_id, endpoint) nulls not distinct;

-- The fan-out read: one scope's live devices, freshest first.
create index if not exists push_subscriptions_live_idx
  on public.push_subscriptions (business_id, last_seen_at desc)
  where revoked_at is null;

-- FK-covering btree (house rule, 20260812000100_fk_covering_indexes.sql).
-- The partial index above cannot serve the businesses cascade for rows that
-- are already revoked.
create index if not exists push_subscriptions_business_id_idx
  on public.push_subscriptions (business_id);

-- Membership revoke and account cleanup key on the person, not the tenant.
create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id)
  where revoked_at is null;

comment on table public.push_subscriptions is
  'Web Push registrations for owner, teammate and HQ-admin browsers. business_id NULL = platform scope. A tap on a delivered notification is recorded in notification_link_clicks with channel=push, which is the only true read receipt any alert channel in this system produces.';
comment on column public.push_subscriptions.business_id is
  'Tenant scope, or NULL for platform-level HQ admin alerts. Nullable by design; see push_subscriptions_scope_endpoint_key for why NULL must dedupe like a value.';
comment on column public.push_subscriptions.endpoint is
  'RFC 8030 push service URL. Host-allowlisted before insert: the server POSTs here, so an arbitrary value is an SSRF vector.';
comment on column public.push_subscriptions.revoked_at is
  'Set when the push service answers 404/410, when the user turns push off, or when their business membership is revoked. Rows are kept rather than deleted so the reason survives for support.';

alter table public.push_subscriptions enable row level security;

-- No policies: service_role bypasses RLS and anon/authenticated are denied by
-- design, the same deny-all posture as slack_connections and
-- whatsapp_connections. Every read and write goes through src/lib/push/db.ts
-- on the server, never from the browser.
grant select, insert, update, delete on table public.push_subscriptions to service_role;
