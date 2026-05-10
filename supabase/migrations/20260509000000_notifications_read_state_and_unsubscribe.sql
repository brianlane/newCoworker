-- Notifications: read/unread state, structured kind+summary, and one-click unsubscribe audit.
--
-- Reasoning
-- ---------
-- The `notifications` table previously only recorded delivery (channel/status/payload)
-- with no notion of whether the owner had seen the row. This blocks a sidebar bell
-- badge and a mark-as-read flow on /dashboard/notifications. We add three columns:
--
--   * `read_at`  — null until the owner views/dismisses the notification.
--   * `kind`     — high-level event class (e.g. urgent_alert, voice_capture, digest)
--                  so the UI can render varied copy without re-parsing `payload`.
--   * `summary`  — short human-readable headline; cheap to render in the badge dropdown
--                  / list view without inspecting nested JSON.
--
-- A partial index on (business_id) WHERE status='sent' AND read_at IS NULL
-- keeps the unread-count query O(N_unread) instead of O(N_total) per
-- business — the badge polls this. The status filter excludes audit-only
-- rows (skipped channels when toggles are off, failed deliveries) so an
-- unsubscribed owner never sees their bell badge climb.
--
-- For RLS we add a column-locked UPDATE policy: owners can flip `read_at` on their
-- own rows but cannot modify history (channel, status, payload). The service role
-- (used by /api/notifications/* routes) bypasses RLS, so the column GRANT is purely
-- defensive against direct supabase-js writes from the browser if we ever wire one.
--
-- Notification preferences gain `unsubscribed_at` for one-click email unsubscribe
-- (RFC 8058 List-Unsubscribe-Post). Setting it is purely an audit/UX hint — the four
-- existing boolean toggles (sms_urgent, email_digest, email_urgent, dashboard_alerts)
-- remain the gate the dispatcher checks. Re-enabling any toggle clears
-- `unsubscribed_at`, which is what the preferences API does on save.

-- ──────────────────────────────────────────────────────────
-- 1. notifications: read_at, kind, summary
-- ──────────────────────────────────────────────────────────
alter table notifications add column if not exists read_at timestamptz;
alter table notifications add column if not exists kind text;
alter table notifications add column if not exists summary text;

-- Backfill `kind` / `summary` for legacy rows so the UI never has to render
-- empty cells. Existing payloads carry their own `summary` already (set by
-- /api/rowboat); pull it through, default kind to 'urgent_alert' since that
-- was the only flow producing rows historically.
update notifications
   set kind = coalesce(kind, 'urgent_alert'),
       summary = coalesce(summary, payload->>'summary')
 where kind is null or summary is null;

create index if not exists notifications_business_unread_idx
  on notifications (business_id, created_at desc)
  where status = 'sent' and read_at is null;

-- ──────────────────────────────────────────────────────────
-- 2. RLS: owners may flip read_at on their own rows
-- ──────────────────────────────────────────────────────────
-- Existing select policy "Owner reads own notifications" stays.
drop policy if exists "Owner marks own notifications read" on notifications;
create policy "Owner marks own notifications read"
  on notifications for update
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  )
  with check (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- Restrict the `authenticated` role to updating only the read_at column. Service
-- role bypasses RLS so /api/* routes are unaffected. This is a defense-in-depth
-- layer: even if a buggy client somehow sent a direct PATCH against the table,
-- it could only set read_at, not rewrite delivery_channel/payload/status/etc.
revoke update on notifications from authenticated;
grant update (read_at) on notifications to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. notification_preferences: unsubscribed_at
-- ──────────────────────────────────────────────────────────
alter table notification_preferences
  add column if not exists unsubscribed_at timestamptz;
