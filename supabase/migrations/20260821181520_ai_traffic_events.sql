-- AI search visibility: are the assistants reading us, and are they sending
-- anyone?
--
-- Two signals in one table, distinguished by `kind`:
--   'crawler'  — a request whose User-Agent is a known AI agent (GPTBot,
--                ClaudeBot, PerplexityBot, ...). Proves we are being read.
--   'referral' — a human visit whose Referer is an AI answer surface
--                (chatgpt.com, perplexity.ai, ...). Proves we are being cited.
--
-- Deliberately NOT analytics: no IP, no session, no user id, no query string.
-- One row records that an agent (or an AI referral) touched a public path at
-- a time, which is all the AEO question needs and nothing a privacy officer
-- has to reason about. Platform ops data, not tenant content, so it is not
-- part of the per-tenant retention window or the end-user erasure surface;
-- the daily sweep prunes it at a fixed 90 days.

create table if not exists public.ai_traffic_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('crawler', 'referral')),
  -- Registry token for a crawler ('GPTBot'), surface label for a referral
  -- ('ChatGPT'). Free text rather than an enum: the registry
  -- (src/lib/marketing/ai-crawlers.ts) gains entries far more often than
  -- this schema should change, and an unknown value is better than a
  -- constraint violation swallowing the signal.
  source text not null,
  operator text not null,
  -- Public marketing path only, never a query string.
  path text not null,
  created_at timestamptz not null default now()
);

-- The admin card's only query shape: a time window, grouped by day and kind.
create index if not exists idx_ai_traffic_events_created
  on public.ai_traffic_events (created_at desc);

alter table public.ai_traffic_events enable row level security;
-- RLS on with zero policies: service-role only, like kg_retrieval_events.
grant select, insert, delete on table public.ai_traffic_events to service_role;
