-- Lower the customer_memory summarizer threshold from 3 interactions
-- down to 1.
--
-- Why: the dashboard chat preamble depends on `customer_memories.summary_md`
-- to give the owner cross-channel continuity ("this person texted on
-- Tuesday asking about a 3br, then called yesterday with a price
-- question"). At a threshold of 3, a customer's first OR second
-- interaction left summary_md NULL, so the preamble's "Recent
-- customer activity" notes lacked the rolled-up narrative the AI
-- needs to answer "what's the latest with this lead" without
-- re-reading every transcript from scratch. Owners reported the AI
-- "rediscovering" the same customer for several turns in a row.
-- Lowering the threshold to 1 fixes that without removing the real
-- safeguard against summarizer thrash, which is the 30s debounce on
-- last_summarized_at (SUMMARY_DEBOUNCE_MS in
-- src/lib/customer-memory/summarizer.ts).
--
-- Mechanics changed by this migration:
--   1. Recreate the partial index that backs the cron sweep so it
--      indexes rows from the very first interaction onward, not just
--      after three.
--   2. Update the comments on customer_memories.summary_md and the
--      idx_customer_memories_summary_due index so a future schema
--      reader sees the current threshold, not the original 3.
--
-- Application-side constants (src/lib/customer-memory/summarizer.ts
-- and supabase/functions/customer-memory-summarize-sweep/index.ts)
-- are updated in the same change set; the index condition here MUST
-- stay in sync with SUMMARY_INTERACTION_THRESHOLD or the cron sweep
-- will silently ignore single-interaction rows.
--
-- Idempotent (DROP INDEX IF EXISTS + CREATE INDEX IF NOT EXISTS) and
-- safe to apply on a populated table: the partial index just gets
-- bigger (now matches every memory row whose interaction_count >= 1
-- instead of >= 3). The cron sweep already re-checks the gate in
-- application code, so a row that doesn't actually need
-- summarization is a cheap no-op skip.

drop index if exists public.idx_customer_memories_summary_due;

create index if not exists idx_customer_memories_summary_due
  on public.customer_memories (business_id, last_summarized_at)
  where interaction_count >= 1;

comment on column public.customer_memories.summary_md is
  'LLM-generated summary, regenerated when interaction_count >= 1 (gated by 30s debounce on last_summarized_at). Capped at ~2000 chars in application code.';
