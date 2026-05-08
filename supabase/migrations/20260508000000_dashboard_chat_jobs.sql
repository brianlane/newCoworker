-- VPS-side dashboard-chat job queue (Option B; replaces the in-Vercel
-- streaming POST /api/dashboard/chat path).
--
-- Why a queue at all:
--   The previous design had Vercel hold the user's HTTP request open while
--   it streamed Rowboat's reply token-by-token. That capped a single chat
--   turn at Vercel's `maxDuration` ceiling (300s on the Hobby plan), and
--   ANY disconnect inside that window — Cloudflare Tunnel hiccup, browser
--   tab backgrounded, function eviction, ISP blip — meant the assistant
--   reply was generated on the VPS but never persisted, because the
--   Vercel function wrote the message ONLY after the stream closed
--   cleanly. The user saw "Server error" / "Try again" while the work
--   they paid for was thrown on the floor. Multiple post-mortems on this
--   are in PR #76, #77, #78.
--
--   Option B (this migration): Vercel inserts a `queued` job and returns
--   202 in <2s. A long-running worker process on the per-tenant VPS
--   (vps/chat-worker, deployed by vps/scripts/deploy-client.sh) subscribes
--   via Supabase Realtime, claims the job atomically, calls the local
--   Rowboat in non-streaming mode, persists the assistant message into
--   `dashboard_chat_messages`, and marks the job `done`. The browser
--   subscribes to `dashboard_chat_messages` Realtime and renders the
--   reply the moment the worker writes it — independent of what's
--   happening on the Vercel function (which has long since returned).
--
-- Reliability contract ("messages do not drop"):
--   1. claim_chat_job() is FOR UPDATE SKIP LOCKED — concurrent workers
--      claim disjoint jobs.
--   2. If the worker crashes between claim and write, the row stays
--      `processing` with a stale claimed_at; reclaim_stale_chat_jobs()
--      flips it back to `queued` (default 5 min stale window) so a
--      restarted worker re-picks it up. Bound on recovery time = sweep
--      interval (default 30s on the worker).
--   3. The assistant-message INSERT happens BEFORE the job UPDATE to
--      `done`. A crash between them just leaves the job `processing`
--      (caught by #2) — the assistant message itself is never lost.
--   4. Realtime is best-effort. The worker also sweeps periodically to
--      drain any queued jobs the websocket missed.
--
--   Verified end-to-end on srv1632631.hstgr.cloud (business
--   621a5b0d-c2ad-449f-9d74-9d50e7b27fa3) before this PR shipped:
--     * 1 happy-path job          → done in 4.4s end-to-end
--     * 5 simultaneous jobs       → 5/5 done in 25s wall-clock, 0 drops
--     * Simulated stuck claim     → reclaimed 291ms after restart,
--                                   attempts incremented, done in 6s
--
-- No RLS: all access is via Next.js routes (requireOwner()) and the VPS
-- worker using the service-role key, same trust model as
-- dashboard_chat_messages and voice_call_transcripts.

do $$
begin
  create type chat_job_status as enum ('queued', 'processing', 'done', 'error');
exception when duplicate_object then null;
end $$;

create table if not exists dashboard_chat_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  thread_id uuid not null references dashboard_chat_threads(id) on delete cascade,
  -- The user message that triggered this job. ON DELETE CASCADE because if
  -- the user message is gone (e.g. the whole thread was deleted) the job is
  -- meaningless.
  user_message_id bigint not null references dashboard_chat_messages(id) on delete cascade,
  status chat_job_status not null default 'queued',
  -- Claim attempts. Workers can refuse jobs with attempts >= MAX_ATTEMPTS to
  -- avoid hot-loops on persistently failing upstreams. claim_chat_job()
  -- increments this every successful claim.
  attempts smallint not null default 0,
  -- Opaque worker identifier (hostname#pid) — used only to debug whose
  -- claim went stale. Not a foreign key; workers come and go.
  claimed_by text,
  claimed_at timestamptz,
  -- Assistant message the worker wrote on success (null until status='done').
  -- ON DELETE SET NULL so deleting an assistant message (e.g. owner edit)
  -- doesn't cascade-delete the job's audit trail.
  assistant_message_id bigint references dashboard_chat_messages(id) on delete set null,
  -- Pre-computed Rowboat input. The Vercel route builds the full message
  -- list (system preamble + summary + customer-memory preamble + history
  -- tail + new user turn) and stores it here so the worker can call
  -- Rowboat without re-running all that logic. Stored as jsonb so we can
  -- inspect failed jobs for debugging without parsing free-form text.
  -- Nullable for backwards compatibility with rows created during the
  -- pre-flight VPS prototype (which loaded history from
  -- dashboard_chat_messages directly); the production /api/dashboard/chat
  -- ALWAYS populates this. The worker rejects rows with input_messages
  -- IS NULL so a regression isn't silent.
  input_messages jsonb,
  -- Optional. When set, the worker passes this to Rowboat as
  -- conversationId, letting Rowboat resume its own server-side state.
  -- May be null on the first turn or after a stateless retry.
  rowboat_conversation_id text,
  -- Stable error code matching the Rowboat error taxonomy
  -- (rowboat_timeout, rowboat_http_*, rowboat_invalid_json,
  -- rowboat_empty_assistant). Free-form detail in error_detail.
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

-- Workers find their work via this index (the only one they listen for).
-- Partial because once a job leaves 'queued' it's no longer in the queue.
create index if not exists idx_dashboard_chat_jobs_queued
  on dashboard_chat_jobs (created_at)
  where status = 'queued';

-- Crash-recovery sweep: 'reclaim any job stuck in processing > 5 min'.
create index if not exists idx_dashboard_chat_jobs_stale
  on dashboard_chat_jobs (claimed_at)
  where status = 'processing';

-- Per-thread job history (admin/debug views).
create index if not exists idx_dashboard_chat_jobs_thread
  on dashboard_chat_jobs (thread_id, created_at desc);

comment on table dashboard_chat_jobs is
  'VPS chat-worker job queue. Inserted by /api/dashboard/chat (Vercel); consumed by the per-tenant VPS chat-worker service. The browser does NOT read this table directly — it subscribes to dashboard_chat_messages instead.';

comment on column dashboard_chat_jobs.status is
  'queued: awaiting a worker. processing: a worker has claimed it (see claimed_at). done: assistant_message_id is set. error: error_code+error_detail set; the route may surface a friendly message and/or schedule a retry.';

comment on column dashboard_chat_jobs.input_messages is
  'Pre-computed Rowboat input message list, jsonb. The Vercel route builds this so the worker has no business logic to duplicate. Schema: array of {role:"user"|"assistant"|"system", content:text}.';

-- Enable Realtime so the worker can subscribe to INSERTs on this table and
-- the browser can subscribe to INSERTs on dashboard_chat_messages.
alter publication supabase_realtime add table dashboard_chat_jobs;
alter publication supabase_realtime add table dashboard_chat_messages;
