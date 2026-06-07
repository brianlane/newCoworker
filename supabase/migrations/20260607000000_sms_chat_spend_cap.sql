-- SMS chat spend cap: route inbound SMS through Gemini, share the owner-chat fuse.
--
-- Context: the inbound SMS reply agent ("Coworker", the workflow startAgent) ran
-- on the local Qwen model. We are repointing it to Gemini 2.5 Flash-Lite for the
-- same latency/quality win PR #104 gave owner-dashboard chat. Gemini bills per
-- token, so SMS now shares the SAME monthly fuse as owner chat: both surfaces
-- meter estimated per-turn cost into owner_chat_model_spend (period-keyed) and,
-- once the COMBINED spend crosses the cap for the period, fall back to the local
-- Qwen agent until the next billing period.
--
-- Design note (why reuse owner_chat_model_spend instead of a new table): the
-- owner picked a single SHARED $10/month pool across owner chat + SMS, so there
-- is exactly one meter row per (business, period). owner_chat_model_spend +
-- owner_chat_record_spend already have the right shape (period-keyed, atomic
-- increment, micro-USD, fuse stamp). SMS reads and increments the same row via
-- the same RPC; whichever surface crosses the cap trips the fuse for both. The
-- table name keeps its historical "owner_chat_" prefix but now covers all
-- per-business chat model spend.

-- ---------------------------------------------------------------------------
-- Exactly-once metering marker for SMS jobs.
--
-- The SMS Edge worker meters a Gemini turn right after it caches the Rowboat
-- reply (before the Telnyx send). A failed send resets the job to 'pending' and
-- the next run reuses rowboat_reply_cached WITHOUT calling Rowboat again (no new
-- model cost), so it must NOT re-meter. The worker atomically claims this column
-- (UPDATE ... WHERE metered_at IS NULL) before owner_chat_record_spend, so a
-- retried/reclaimed run skips metering. Null = not yet metered.
-- ---------------------------------------------------------------------------
alter table sms_inbound_jobs
  add column if not exists metered_at timestamptz;

comment on column sms_inbound_jobs.metered_at is
  'Set once by the SMS inbound worker when it records this job''s SMS-chat (Gemini) spend into the shared owner_chat_model_spend meter, claimed atomically (WHERE metered_at IS NULL) so a retried/reclaimed run (e.g. cached reply re-send) does not double-count spend against the period fuse.';

-- ---------------------------------------------------------------------------
-- Re-document the shared meter (table + RPC) now that SMS contributes to it.
-- No structural change — owner_chat_model_spend / owner_chat_record_spend are
-- reused verbatim as the single per-business, per-period combined chat fuse.
-- ---------------------------------------------------------------------------
comment on table owner_chat_model_spend is
  'Per-business, per-billing-period SHARED chat-model (Gemini) spend meter + runaway fuse, covering BOTH owner-dashboard chat AND inbound SMS replies. Spend in micro-USD. Keyed by stripe_current_period_start so the fuse auto-resets each period. Once combined spend crosses the cap, both surfaces fall back to the local Qwen agent until the next period.';

comment on function owner_chat_record_spend is
  'Atomically add chat-model cost (micro-USD) to the shared per-business/period meter (owner chat + SMS both call this), bump the turn count, and trip the fuse on first cap crossing. Returns new total + whether this call tripped the fuse.';
