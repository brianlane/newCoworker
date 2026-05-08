-- Preserve Rowboat's per-conversation state through the chat-worker job
-- queue (Codex P2 review on PR #79).
--
-- Why this matters:
--   dashboard_chat_threads has carried `rowboat_state jsonb` since the
--   chat surface was first built (migration 20260427000000). Rowboat's
--   /chat HTTP API takes BOTH conversationId and state on continuation
--   calls; the conversationId addresses Rowboat's server-side memory,
--   `state` is the client-carried tool/agent state that Rowboat hands
--   us back on every response. The pre-Option-B streaming route always
--   passed both up and persisted both back.
--
--   PR #79 initially passed only `rowboat_conversation_id` to the worker
--   and dropped `rowboat_state`. For threads with stateful tool loops
--   (e.g. multi-turn lookups, partial form fills) the next worker call
--   would resume with a conversationId but a blank state on Rowboat's
--   side, losing context and forcing extra stateless retries. This
--   column re-adds state through the job row so the worker can forward
--   it on the Rowboat call AND persist the updated state back to the
--   thread on success.
--
-- Null when:
--   - First turn on a fresh thread (Rowboat hasn't issued state yet).
--   - After a stateless retry that succeeded (the previous state went
--     down with the rejected conversationId; thread.rowboat_state is
--     NULLed alongside thread.rowboat_conversation_id).

alter table dashboard_chat_jobs
  add column if not exists rowboat_state jsonb;

comment on column dashboard_chat_jobs.rowboat_state is
  'Rowboat client-carried state to forward on the worker''s first attempt. Null on fresh threads / after stateless retry. Worker persists Rowboat''s response state back to dashboard_chat_threads.rowboat_state on success.';
