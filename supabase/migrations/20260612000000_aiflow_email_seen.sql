-- Inbound-email trigger poll: per-(flow, message) evaluation markers.
--
-- The poller caps how many mailbox messages it reads per tick. Run dedupe
-- keys only exist for messages that MATCHED a flow, so non-matching mail
-- would refill that read budget every tick and could starve unread messages
-- for the whole lookback window. A marker row is written once a flow has
-- evaluated a message (match or not); the poller only spends budget on
-- (flow, message) pairs with no marker yet, so every message is evaluated by
-- every flow exactly once and bursts drain across ticks.
--
-- Rows only matter inside the poll lookback window (minutes); the poller
-- prunes anything older than a day on each tick, so the table stays tiny.

create table if not exists public.ai_flow_email_seen (
  flow_id uuid not null references public.ai_flows(id) on delete cascade,
  message_id text not null,
  seen_at timestamptz not null default now(),
  primary key (flow_id, message_id)
);

create index if not exists ai_flow_email_seen_seen_at_idx
  on public.ai_flow_email_seen (seen_at);

-- Service-role only (the poller); no anon/authenticated policies on purpose.
alter table public.ai_flow_email_seen enable row level security;
