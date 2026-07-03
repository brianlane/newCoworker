-- RCS messaging channel (Standard/Enterprise perk).
--
-- `business_channel_settings` holds the per-tenant RCS agent wiring. RCS
-- sends go out through Telnyx `POST /v2/messages/rcs` from the tenant's
-- EXISTING number (sms_fallback.from) — no new number and no per-tenant
-- platform fee. A tenant is RCS-capable only when:
--   1. their Google-verified Telnyx RCS agent is approved (rcs_agent_id set),
--   2. an operator flipped rcs_enabled on, AND
--   3. their tier allows it (standard/enterprise — enforced in code, both in
--      src/lib/telnyx/messaging.ts and supabase/functions/_shared/
--      channel_settings.ts, so a tier downgrade instantly demotes sends to
--      plain SMS without a schema touch).
--
-- The `channel` columns tag message records so threads can show which channel
-- delivered ('sms' default keeps every historical row valid).

create table if not exists public.business_channel_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  -- Telnyx RCS agent id (from agent onboarding). Null until carrier approval.
  rcs_agent_id text,
  -- Operator kill switch, default off: agent approval alone must not flip
  -- traffic to a channel nobody has smoke-tested for this tenant.
  rcs_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.business_channel_settings is
  'Per-tenant messaging channel wiring (RCS agent id + enable flag). Tier gate (standard/enterprise) is enforced in code.';

alter table public.business_channel_settings enable row level security;

drop policy if exists "Service role manages business_channel_settings" on public.business_channel_settings;
create policy "Service role manages business_channel_settings"
  on public.business_channel_settings for all
  using (auth.role() = 'service_role');

drop policy if exists "Owner reads own channel settings" on public.business_channel_settings;
create policy "Owner reads own channel settings"
  on public.business_channel_settings for select
  using (
    business_id in (
      select id from public.businesses where owner_email = auth.email()
    )
  );

-- Channel tags on message records ('sms' | 'rcs').
alter table public.sms_outbound_log
  add column if not exists channel text not null default 'sms'
  check (channel in ('sms', 'rcs'));

comment on column public.sms_outbound_log.channel is
  'Delivery channel the send was attempted on: sms (plain) or rcs (RCS-first with SMS fallback).';

alter table public.sms_inbound_jobs
  add column if not exists channel text not null default 'sms'
  check (channel in ('sms', 'rcs'));

comment on column public.sms_inbound_jobs.channel is
  'Channel the inbound message arrived on: sms or rcs (payload.type=RCS from the Telnyx webhook).';

-- The worker's reply can go out on a DIFFERENT channel than the inbound
-- arrived on (e.g. RCS inbound answered over plain SMS after an RCS API
-- rejection). Nullable: null = unknown/legacy, treated as sms by readers.
alter table public.sms_inbound_jobs
  add column if not exists reply_channel text
  check (reply_channel in ('sms', 'rcs'));

comment on column public.sms_inbound_jobs.reply_channel is
  'Channel the worker reply was actually delivered on (sms/rcs). Null for legacy rows or jobs without a delivered reply.';
