-- Scheduled + template SMS (Standard/Enterprise perk, tier relaunch).
--
-- Two owner-facing tools on the dashboard Text history page:
--   1. sms_templates    — saved message bodies the owner reuses when composing.
--   2. scheduled_sms    — owner-composed texts queued for a future send time,
--                          dispatched by the scheduled-sms-sweep Edge cron.
--
-- Sends are customer-facing → metered through try_reserve_sms_outbound_slot
-- like every other outbound SMS, and logged to sms_outbound_log (source
-- 'owner_scheduled') so they render inline in the conversation thread.
-- Tier gating (standard/enterprise) is enforced in the API routes and
-- re-checked at dispatch time by the sweep.

-- ---------------------------------------------------------------------------
-- Saved templates
-- ---------------------------------------------------------------------------
create table if not exists public.sms_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  body text not null check (char_length(body) between 1 and 1600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sms_templates is
  'Owner-saved SMS message templates (Standard+ perk). Bodies are sent verbatim - no variable substitution.';

-- One template name per business (case-insensitive) so the picker stays sane.
create unique index if not exists sms_templates_business_name_idx
  on public.sms_templates (business_id, lower(name));

alter table public.sms_templates enable row level security;

drop policy if exists "Service role manages sms_templates" on public.sms_templates;
create policy "Service role manages sms_templates"
  on public.sms_templates for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Scheduled sends
-- ---------------------------------------------------------------------------
create table if not exists public.scheduled_sms (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  to_e164 text not null,
  body text not null check (char_length(body) between 1 and 1600),
  send_at timestamptz not null,
  -- pending  → waiting for send_at
  -- sending  → claimed by a sweep run (stale claims are reclaimed after 10 min)
  -- sent     → delivered to Telnyx
  -- canceled → owner canceled before dispatch, or recipient opted out
  -- failed   → dispatch failed (tier, messaging config, SMS cap, Telnyx error)
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'canceled', 'failed')),
  error text,
  telnyx_message_id text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz
);

comment on table public.scheduled_sms is
  'Owner-scheduled outbound SMS (Standard+ perk), dispatched by the scheduled-sms-sweep Edge cron.';

create index if not exists scheduled_sms_due_idx
  on public.scheduled_sms (status, send_at);

create index if not exists scheduled_sms_business_idx
  on public.scheduled_sms (business_id, send_at desc);

alter table public.scheduled_sms enable row level security;

drop policy if exists "Service role manages scheduled_sms" on public.scheduled_sms;
create policy "Service role manages scheduled_sms"
  on public.scheduled_sms for all
  using (auth.role() = 'service_role');

-- Atomically claim due rows for one sweep run. FOR UPDATE SKIP LOCKED means
-- two overlapping cron invocations can never claim the same row. A 'sending'
-- row whose claim is older than 10 minutes is presumed orphaned (sweep died
-- mid-dispatch) and is reclaimable — the Telnyx idempotency key
-- (scheduled_sms:<id>) makes the retried send safe.
create or replace function public.claim_due_scheduled_sms(p_limit integer)
returns setof public.scheduled_sms
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  update public.scheduled_sms s
  set status = 'sending', claimed_at = now()
  where s.id in (
    select id from public.scheduled_sms
    where (status = 'pending' and send_at <= now())
       or (status = 'sending' and claimed_at < now() - interval '10 minutes')
    order by send_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  returning s.*;
end;
$$;

revoke execute on function public.claim_due_scheduled_sms(integer) from public;
grant execute on function public.claim_due_scheduled_sms(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Outbound log source
-- ---------------------------------------------------------------------------
alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual', 'owner_scheduled'));

comment on column public.sms_outbound_log.source is
  'Where the send came from: ai_flow (send_sms step), agent_offer (route_to_team offer), owner_notify (approval/notify_owner/claim notice), owner_manual (owner-typed reply/compose from the dashboard SMS thread), or owner_scheduled (scheduled send dispatched by the sweep).';
