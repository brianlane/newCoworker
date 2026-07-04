-- AI call summaries + sentiment (Standard/Enterprise perk, tier relaunch).
--
-- Each completed voice call gets a short AI-written digest and a sentiment
-- label, rendered on the dashboard Call history list and the per-call
-- transcript page. Competitors charge per-seat for this (Aircall AI Assist
-- $9/license, CloudTalk AI €9/user); our marginal cost is pennies of Gemini
-- Flash inside the tenant's existing shared AI budget.
--
-- Pipeline:
--   pg_cron (*/5) → Edge `call-summary-sweep` (scan + tier filter)
--     → Next.js `/api/internal/summarize-call` (Gemini JSON call, metered
--        via meterGeminiSpendForBusiness) → columns below.
--
-- Retry contract:
--   * summarized_at IS NULL + attempts < cap → sweep retries next pass.
--   * summarized_at set → terminal (success OR permanent skip like an empty
--     transcript); never revisited.
--   * summary_attempts counts failed attempts so a poisoned row can't spin
--     the sweep forever; the sweep also windows to recent calls, so old
--     backlog is never mass-summarized after an upgrade.

alter table public.voice_call_transcripts
  add column if not exists summary text,
  add column if not exists sentiment text
    check (sentiment in ('positive', 'neutral', 'negative', 'mixed')),
  add column if not exists summarized_at timestamptz,
  add column if not exists summary_error text,
  add column if not exists summary_attempts integer not null default 0;

comment on column public.voice_call_transcripts.summary is
  'AI-written digest of the call (Standard+ perk). NULL until the call-summary sweep processes the row.';

comment on column public.voice_call_transcripts.sentiment is
  'Caller sentiment label from the same Gemini pass as summary.';

comment on column public.voice_call_transcripts.summarized_at is
  'Terminal marker: set on success or permanent skip (e.g. empty transcript). NULL rows inside the sweep window retry.';

comment on column public.voice_call_transcripts.summary_error is
  'Last summarizer failure detail (transient — row retries until summary_attempts hits the cap).';

comment on column public.voice_call_transcripts.summary_attempts is
  'Failed summarizer attempts; the sweep stops retrying after the cap so a poisoned row cannot spin forever.';

-- The sweep scans completed-but-unsummarized rows newest-first. Partial index
-- keeps this cheap no matter how large the transcript table grows.
create index if not exists voice_call_transcripts_summary_pending_idx
  on public.voice_call_transcripts (ended_at desc)
  where status = 'completed' and summarized_at is null;
