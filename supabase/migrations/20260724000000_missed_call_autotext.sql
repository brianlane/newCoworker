-- Auto-text on missed calls (Standard/Enterprise perk, tier relaunch Phase C6).
--
-- When an inbound call is refused (all concurrent slots busy, or voice
-- minutes exhausted) the caller currently hears a short message and is
-- dropped. For Standard+ tenants we now follow up with one SMS from the
-- business's own number so the conversation continues over text (the
-- AI answers the reply through the normal SMS pipeline).
--
-- Helper: supabase/functions/_shared/missed_call_autotext.ts, called from
-- telnyx-voice-inbound. Sends are customer-facing → metered through
-- try_reserve_sms_outbound_slot like every other outbound SMS.

-- Per-tenant kill switch (default ON — the perk is part of the tier).
alter table public.business_channel_settings
  add column if not exists missed_call_autotext_enabled boolean not null default true;

comment on column public.business_channel_settings.missed_call_autotext_enabled is
  'Auto-text callers whose call was refused (concurrency/quota). Tier gate (standard/enterprise) is enforced in code.';

-- Send log doubles as the dedup ledger: one auto-text per (business, caller)
-- per window, claimed atomically by try_mark_missed_call_autotext.
create table if not exists public.missed_call_autotexts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  caller_e164 text not null,
  -- Why the call was refused: 'concurrent_limit' | 'quota_exhausted'.
  reason text not null,
  telnyx_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists missed_call_autotexts_dedup_idx
  on public.missed_call_autotexts (business_id, caller_e164, created_at desc);

comment on table public.missed_call_autotexts is
  'Missed-call auto-text sends; also the once-per-window dedup ledger (try_mark_missed_call_autotext).';

alter table public.missed_call_autotexts enable row level security;

drop policy if exists "Service role manages missed_call_autotexts" on public.missed_call_autotexts;
create policy "Service role manages missed_call_autotexts"
  on public.missed_call_autotexts for all
  using (auth.role() = 'service_role');

-- Atomically claim the right to auto-text this caller: inserts a ledger row
-- and returns its id, or null when a send to the same caller already exists
-- within the window. The advisory xact lock serializes concurrent refusals
-- for the same (business, caller) so two simultaneous missed calls can't
-- both claim.
create or replace function public.try_mark_missed_call_autotext(
  p_business_id uuid,
  p_caller_e164 text,
  p_reason text,
  p_window_seconds integer
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_business_id::text || ':' || p_caller_e164));
  if exists (
    select 1 from public.missed_call_autotexts
    where business_id = p_business_id
      and caller_e164 = p_caller_e164
      and created_at > now() - make_interval(secs => p_window_seconds)
  ) then
    return null;
  end if;
  insert into public.missed_call_autotexts (business_id, caller_e164, reason)
  values (p_business_id, p_caller_e164, p_reason)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.try_mark_missed_call_autotext(uuid, text, text, integer) from public;
grant execute on function public.try_mark_missed_call_autotext(uuid, text, text, integer) to service_role;
