-- Forwarded / transferred calls in Call history.
--
-- Call history reads `voice_call_transcripts`, which the VPS voice bridge writes
-- ONLY for AI-handled calls (Gemini Live). Calls the routing layer blind-transfers
-- or warm-hands-off straight to a human — per-caller transfer rules, voice-AiFlow
-- `transfer`/`handoff`, safe-mode forwards — never engage the bridge, so no row is
-- written and the call is invisible in Call history (and the dashboard activity
-- feed). Dave's Clever Live-Transfer calls are exactly this case.
--
-- telnyx-voice-call-end knows each forwarded call's final outcome (call.bridged /
-- normal_clearing = a human answered; a no-prior-bridge hangup = no-answer), so it
-- now upserts a lightweight `call_kind = 'forwarded'` row here at outcome time. These
-- rows carry no AI transcript turns; they exist purely so the call appears in the log.
--
-- New columns:
--   * call_kind         — 'ai' (bridge-written, has turns) vs 'forwarded'
--                         (routing-written, no turns). Default 'ai' so every
--                         existing row is unchanged.
--   * forwarded_to_e164 — who the call was forwarded/transferred to (the human).
--
-- status gains 'missed' for a forwarded call that rang out unanswered. AI rows
-- keep using in_progress / completed / errored exactly as before.

alter table public.voice_call_transcripts
  add column if not exists call_kind text not null default 'ai'
    check (call_kind in ('ai', 'forwarded')),
  add column if not exists forwarded_to_e164 text;

comment on column public.voice_call_transcripts.call_kind is
  'ai = bridge-written AI call (has transcript turns); forwarded = routing-written record of a call transferred/forwarded to a human (no turns).';

comment on column public.voice_call_transcripts.forwarded_to_e164 is
  'For call_kind=forwarded: the human number the call was transferred/forwarded to. NULL for AI calls.';

-- Extend the status check to allow 'missed' (a forwarded call nobody answered).
-- The column is an inline unnamed check; drop the auto-named constraint and
-- recreate it with the extra value. Both names are tried so this is safe whether
-- the constraint was created inline (…_status_check) or explicitly.
alter table public.voice_call_transcripts
  drop constraint if exists voice_call_transcripts_status_check;

alter table public.voice_call_transcripts
  add constraint voice_call_transcripts_status_check
    check (status in ('in_progress', 'completed', 'errored', 'missed'));

-- The call-summary sweep already filters status='completed', so 'forwarded'
-- rows (completed or missed) with no turns won't be summarized. Belt-and-braces:
-- forwarded rows are written with summarized_at set (see forwarded_call_log.ts)
-- so even a completed forwarded row is never dispatched to the summarizer.
