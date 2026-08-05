-- notify_owner cooldowns: one owner text per key per window.
--
-- The HQ team-inbox triage flow texted Brian twice inside a minute about one
-- Gmail conversation: an intro, then its "Re:" reply. Each message is a
-- distinct provider message id, so each is a distinct run, so each is a
-- distinct SMS. Nothing in the notify path had ever looked across runs:
-- ai_flow_email_seen is per (flow, message), the Telnyx idempotency key is per
-- run, and the customer_reply / team_notify coalescing windows live on the
-- separate `notifications` surface that owner alerts do not use.
--
-- This table is that missing cross-run memory. A notify_owner step may declare
-- `cooldown: { key, minutes }` with a TEMPLATED key ("{{trigger.thread_id}}"
-- for one text per email conversation, "{{vars.lead_phone}}" for one per
-- lead), and the claim below decides whether this run's text goes out.
--
-- Two properties the claim has to hold:
--   1. Atomic. Two runs of the same flow can be claimed by different worker
--      invocations at the same instant (the poller enqueues a whole tick's
--      messages together), so read-then-write would let both through. The
--      conditional upsert below decides in one statement under the row lock.
--   2. Stamped only on an ACTUAL send. If a thread's first message did not
--      match the notify step's `when` (an automated notice, say), no window
--      opens, and the later reply that IS a real lead still alerts.

create table if not exists public.ai_flow_notify_cooldowns (
  business_id uuid not null references public.businesses(id) on delete cascade,
  flow_id uuid not null references public.ai_flows(id) on delete cascade,
  -- The authored step id, not its position: reordering a flow's steps must
  -- not reset a window that is still open.
  step_id text not null,
  -- The RENDERED key. Never empty: an empty render disables the cooldown for
  -- that run (the planner drops the whole cooldown object) rather than
  -- collapsing every alert onto one shared blank key.
  cooldown_key text not null,
  last_notified_at timestamptz not null default now(),
  primary key (business_id, flow_id, step_id, cooldown_key)
);

comment on table public.ai_flow_notify_cooldowns is
  'Open notify_owner cooldown windows. One row per (business, flow, step, rendered key); last_notified_at is stamped only when an owner SMS actually went out.';

alter table public.ai_flow_notify_cooldowns enable row level security;
grant select, insert, update, delete on table public.ai_flow_notify_cooldowns to service_role;

-- Prune scan: the retention sweep deletes windows long past any usable
-- minutes value (the schema caps `minutes` at one week).
create index if not exists ai_flow_notify_cooldowns_last_notified_idx
  on public.ai_flow_notify_cooldowns (last_notified_at);

-- Claim the window. Returns true when the caller should SEND (no open window,
-- or the previous one has expired) and false when the send must be skipped.
--
-- The `where` on the conflict branch is what makes this atomic: an open window
-- matches no row to update, so the upsert affects zero rows and the RETURNING
-- yields nothing. An expired one is refreshed to now() in the same statement
-- that reports it, so the second caller in a race sees a fresh window and skips.
create or replace function public.ai_flow_claim_notify_cooldown(
  p_business_id uuid,
  p_flow_id uuid,
  p_step_id text,
  p_cooldown_key text,
  p_minutes integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claimed boolean;
begin
  -- No key, or a nonsensical window: never suppress a send. Failing OPEN is
  -- the right default for an alert path (a duplicate text is a nuisance, a
  -- swallowed lead alert is a lost lead).
  if p_cooldown_key is null or length(trim(p_cooldown_key)) = 0
     or p_minutes is null or p_minutes <= 0 then
    return true;
  end if;

  insert into public.ai_flow_notify_cooldowns as c
    (business_id, flow_id, step_id, cooldown_key, last_notified_at)
  values (p_business_id, p_flow_id, p_step_id, trim(p_cooldown_key), now())
  on conflict (business_id, flow_id, step_id, cooldown_key) do update
    set last_notified_at = now()
    where c.last_notified_at < now() - make_interval(mins => p_minutes)
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke execute on function public.ai_flow_claim_notify_cooldown(uuid, uuid, text, text, integer) from public;
revoke execute on function public.ai_flow_claim_notify_cooldown(uuid, uuid, text, text, integer) from anon, authenticated;
grant execute on function public.ai_flow_claim_notify_cooldown(uuid, uuid, text, text, integer) to service_role;
