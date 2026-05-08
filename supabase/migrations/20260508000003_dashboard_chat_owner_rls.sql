-- SELECT policies for /dashboard/chat surface so the browser-side
-- @supabase/supabase-js client (with the user's JWT) can subscribe to
-- dashboard_chat_messages via Realtime and observe the worker's
-- assistant-message INSERTs as they happen.
--
-- Why this is gated specifically:
--   The /dashboard/chat surface previously relied on the browser
--   never reading these tables directly — every read went through a
--   service-role server route. PR #79 moves chat reply delivery from
--   in-Vercel streaming to a VPS-side worker that writes assistant
--   messages back to dashboard_chat_messages. The browser needs to
--   observe those INSERTs without polling-only fallback. Realtime
--   delivers those events ONLY when the subscriber satisfies a SELECT
--   policy on the table — without one, the client websocket connects
--   successfully but receives nothing, which looks identical to "the
--   model never replied" from the user's perspective.
--
-- Ownership model (mirrors src/lib/auth.ts::requireOwner):
--   businesses.owner_email == auth.users.email (case-insensitive)
--   - There is no owner_id UUID column on businesses; the source of
--     truth is the email address. We compare on lower(email) on both
--     sides because Supabase's auth.users.email is preserved as-typed
--     while businesses.owner_email is normalized at write time.
--
-- Admin override:
--   The ADMIN_EMAIL allowlist used in src/lib/auth.ts is a server-
--   side env var; we DON'T re-implement it here because the admin's
--   chat workflow goes through the same server routes (which use
--   service role and bypass RLS anyway). The owner-email policy is
--   sufficient for the browser case.
--
-- Performance:
--   The exists() subquery is a single PK lookup on
--   dashboard_chat_threads + a single index lookup on
--   businesses(id). Both are sub-millisecond and Supabase's Realtime
--   ApplyRLS path runs the same policy for filter evaluation, so the
--   per-event cost is the cost of two PK lookups. At one Realtime
--   subscriber per active dashboard chat, this is well below the
--   instance's per-connection budget.
--
-- Why we don't open dashboard_chat_jobs to authenticated:
--   The polling endpoint /api/dashboard/chat/jobs/[id] already
--   serves what the browser needs (status + assistantMessageId)
--   through service-role + requireOwner. Exposing the jobs table
--   directly would also leak input_messages / stateless_input_messages,
--   which are NOT meant for the client (they contain the system
--   preambles the user shouldn't see). Keep that table service-only.

-- ---------------------------------------------------------------------
-- dashboard_chat_messages: SELECT policy for the owner.
-- ---------------------------------------------------------------------
drop policy if exists chat_messages_owner_select on public.dashboard_chat_messages;
create policy chat_messages_owner_select
  on public.dashboard_chat_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.dashboard_chat_threads t
      join public.businesses b on b.id = t.business_id
      where t.id = dashboard_chat_messages.thread_id
        and lower(b.owner_email) = lower((auth.jwt() ->> 'email')::text)
    )
  );

comment on policy chat_messages_owner_select on public.dashboard_chat_messages is
  'Owner read access for /dashboard/chat. Required for Realtime subscriptions on the post-PR-#79 enqueue-and-deliver path. See migration 20260508000003.';

-- ---------------------------------------------------------------------
-- dashboard_chat_threads: SELECT policy. Strictly required by
-- @supabase/supabase-js when the client wants to filter Realtime
-- events through a join clause (it pre-validates the filter against
-- the user's allowed rows). We don't currently subscribe to threads,
-- but exposing reads here keeps the surface symmetrical and allows
-- future client features (e.g. a "thread updated" indicator) to work
-- without another migration.
-- ---------------------------------------------------------------------
drop policy if exists chat_threads_owner_select on public.dashboard_chat_threads;
create policy chat_threads_owner_select
  on public.dashboard_chat_threads
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.businesses b
      where b.id = dashboard_chat_threads.business_id
        and lower(b.owner_email) = lower((auth.jwt() ->> 'email')::text)
    )
  );

comment on policy chat_threads_owner_select on public.dashboard_chat_threads is
  'Owner read access for /dashboard/chat thread metadata. Pairs with chat_messages_owner_select (migration 20260508000003).';
