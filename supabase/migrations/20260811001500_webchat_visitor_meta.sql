-- Passive visitor metadata for website-chat-widget sessions.
--
-- Written once at session start (approximate IP-derived location, coarse
-- device summary, and the loader-reported page/referrer/UTM/language/
-- screen/timezone/returning/time-on-page), then appended to as the
-- visitor navigates while the chat is open (pages trail). THE RAW IP IS
-- NEVER STORED — only coarse derived facts (see
-- src/lib/webchat/visitor-meta.ts). Shown on the admin/owner transcript
-- views.
--
-- NOTE on the version stamp: the production ledger head is already at
-- 20260810232100 (historic invented-future stamps), so a real-clock stamp
-- would sort before it and fail `supabase db push`. This stamp continues
-- the ledger's forward order instead.
alter table webchat_sessions
  add column if not exists visitor_meta jsonb;

comment on column webchat_sessions.visitor_meta is
  'Passive visitor metadata (geo derived from IP — never the IP itself — device summary, page/referrer/UTM, page trail). See src/lib/webchat/visitor-meta.ts.';
