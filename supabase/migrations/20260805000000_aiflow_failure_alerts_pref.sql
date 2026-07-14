-- AiFlow failure alerts: opt-in owner notification when a lead-intake AiFlow
-- run dead-letters (Truly Insurance feedback, 2026-07-13). A failed
-- tenant_email/webhook run means a lead arrived and the automation died —
-- previously visible only as an error-level system log nobody watches.
--
-- Default OFF by design (unlike the other alert toggles): failed runs page
-- the owner only after they explicitly opt in from the notifications page.
--
-- Version 20260805000000 sorts after the newest applied remote ledger entry
-- (20260804000100) so the CI `supabase db push` applies it in order.

alter table public.notification_preferences
  add column if not exists aiflow_failure_alerts boolean not null default false;

comment on column public.notification_preferences.aiflow_failure_alerts is
  'Opt-in (default false): notify the owner when a lead-intake AiFlow run fails permanently (dead-letter), so a dead automation is never silent.';
