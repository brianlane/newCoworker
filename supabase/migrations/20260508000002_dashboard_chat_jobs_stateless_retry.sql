-- Stateless-retry input for the chat-worker.
--
-- Why a second jsonb column instead of "have the worker rebuild it":
--   The worker is intentionally dumb (~300 lines of plain Node.js) and
--   has no business-logic dependency on the rest of the codebase. The
--   route already runs `buildRowboatChatMessages` to produce the first-
--   attempt input — building the stateless variant is a one-line change
--   (`includeTailContext: true`, drop conversationId), and forwarding it
--   on the job row is cheaper (in maintenance terms) than porting the
--   message-builder + customer-preamble + summary code into the worker.
--
-- When this is null:
--   The first attempt's input is ALREADY stateless (fresh thread, no
--   continuation to invalidate). Worker treats null as "no fallback
--   path" — the first attempt's error is final. This is correct because
--   if a stateless call ALREADY failed there's nothing different a
--   second stateless call would do.
--
-- When this is non-null:
--   The first attempt was a continuation call (input_messages omits the
--   tail-as-system because Rowboat replays its own server-side state).
--   On a STATELESS_RETRY_ERRORS-class failure (Rowboat rejected the
--   conversationId, or its server-side state went sideways), the worker
--   retries with this variant AND without rowboat_conversation_id.
--   Identical contract to the pre-Option-B streaming retry on the
--   Vercel route — see PR #76 / src/app/api/dashboard/chat/route.ts.
--
-- After a successful stateless retry, the worker also nulls out
-- dashboard_chat_threads.rowboat_conversation_id (the stored id is
-- known-bad). Without that, the NEXT turn would re-send the same dead
-- id, fail, retry stateless again, and pay 2x latency forever.

alter table dashboard_chat_jobs
  add column if not exists stateless_input_messages jsonb;

comment on column dashboard_chat_jobs.stateless_input_messages is
  'Pre-computed Rowboat input for the stateless-retry attempt (tail-as-system message included, no conversationId on the worker side). Null when the first-attempt input is already stateless and there is no fallback to escalate to.';
