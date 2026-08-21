-- Two residency invariants that were documented in prose and enforced nowhere.
--
-- 1. A KEEP-HOURS FLOOR ON THE PURGE.
--
-- residency_purge_business(p_business, p_keep_hours) accepted any value >= 0.
-- Meanwhile the engine reads several PURGED tables over fixed recency
-- windows, and the widest of them is exactly the purge default:
--
--   CONTACT_TIMELINE_LOOKBACK_HOURS = 72   _shared/contact_context.ts
--   NEEDS_HUMAN_REPAGE_HOURS        = 24   _shared/needs_human.ts
--   DEFAULT_DIAL_WINDOW_HOURS       = 24   _shared/ai_flows/call_guards.ts
--
-- So the safety of the contact timeline rested on an operator not passing
-- --keep-hours below 72, with nothing to stop them. `--keep-hours 24` would
-- silently truncate the AI's cross-channel view of a contact mid
-- conversation: not an error, just a model that no longer knows what the
-- customer said two days ago. The floor is enforced here as well as in
-- debug/residency-purge.ts because the RPC is callable directly and the
-- wrapper is not the only door.
--
-- Kept in lockstep with RESIDENCY_MIN_KEEP_HOURS in
-- src/lib/residency/keep-window.ts by tests/residency-keep-window.test.ts.
--
-- 2. A REPLAY-CRON PRECONDITION ON THE MODE FLIP.
--
-- 20260812000200_unschedule_residency_replay.sql unscheduled
-- 'edge-residency-replay' while zero tenants use residency. `dual` does not
-- replicate without it, so flipping a tenant to `dual` today produces a
-- journal that grows forever and never drains. README step 0 says to
-- re-schedule the cron first; nothing enforced it, and the admin UI offered
-- the flip regardless. residency_replay_cron_active() lets the app check,
-- because cron.job is not reachable through the Data API.

-- ── 1. keep-hours floor ─────────────────────────────────────────────────
create or replace function public.residency_purge_business(
  p_business uuid,
  p_keep_hours integer default 72
)
returns table (table_name text, purged bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
  v_mode text;
  v_pending bigint;
  v_cutoff timestamptz;
  n bigint;
begin
  -- Floor, not just >= 0: see the header. 72 is the widest engine lookback
  -- window over a purged table (CONTACT_TIMELINE_LOOKBACK_HOURS).
  if p_keep_hours < 72 then
    raise exception
      'residency_purge_business: p_keep_hours=% is below the 72h engine floor. The coworker reads purged tables over fixed recency windows (contact timeline 72h, needs-human repage 24h, dial cap 24h); purging inside them silently truncates what the AI knows mid conversation. Raise keep-hours, or narrow the engine windows first (src/lib/residency/keep-window.ts).',
      p_keep_hours;
  end if;

  select tier, data_residency_mode into v_tier, v_mode
    from public.businesses where id = p_business;
  if v_tier is distinct from 'enterprise' or v_mode is distinct from 'vps' then
    raise exception
      'residency_purge_business: % is not an enterprise tenant in vps mode (tier=%, mode=%)',
      p_business, coalesce(v_tier, '<missing>'), coalesce(v_mode, '<missing>');
  end if;

  select count(*) into v_pending
    from public.residency_write_journal
   where business_id = p_business and replayed_at is null;
  if v_pending > 0 then
    raise exception
      'residency_purge_business: % pending journal rows, drain before purging (unreplicated content would be lost)',
      v_pending;
  end if;

  v_cutoff := now() - make_interval(hours => p_keep_hours);
  -- Mute the journal triggers for THIS transaction only.
  perform set_config('app.residency_purge', 'true', true);

  delete from public.email_log
   where business_id = p_business and created_at < v_cutoff;
  get diagnostics n = row_count;
  table_name := 'email_log'; purged := n; return next;

  delete from public.sms_outbound_log
   where business_id = p_business and created_at < v_cutoff;
  get diagnostics n = row_count;
  table_name := 'sms_outbound_log'; purged := n; return next;

  -- Terminal calls only; in_progress rows are live state. Turns follow via
  -- their FK cascade inside the same muted transaction.
  delete from public.voice_call_transcripts
   where business_id = p_business
     and created_at < v_cutoff
     and status in ('completed', 'errored', 'missed');
  get diagnostics n = row_count;
  table_name := 'voice_call_transcripts'; purged := n; return next;

  delete from public.voice_outbound_dial_log
   where business_id = p_business and created_at < v_cutoff;
  get diagnostics n = row_count;
  table_name := 'voice_outbound_dial_log'; purged := n; return next;

  -- Read notifications only: unread ones still drive the dashboard badge.
  delete from public.notifications
   where business_id = p_business and created_at < v_cutoff and read_at is not null;
  get diagnostics n = row_count;
  table_name := 'notifications'; purged := n; return next;

  delete from public.scheduled_sms
   where business_id = p_business
     and send_at < v_cutoff
     and status in ('sent', 'canceled', 'failed');
  get diagnostics n = row_count;
  table_name := 'scheduled_sms'; purged := n; return next;

  delete from public.sms_owner_reply_prompts
   where business_id = p_business and created_at < v_cutoff and answered_at is not null;
  get diagnostics n = row_count;
  table_name := 'sms_owner_reply_prompts'; purged := n; return next;
end;
$$;

revoke all on function public.residency_purge_business(uuid, integer) from public;
grant execute on function public.residency_purge_business(uuid, integer) to service_role;

-- ── 2. replay-cron precondition ─────────────────────────────────────────
-- Self-sufficient regardless of ordering, the same line every other
-- cron-touching migration here opens with.
create extension if not exists pg_cron;

-- SECURITY DEFINER because cron.job is owned by the extension and is not in
-- any Data API schema; the app has no other way to ask this question.
create or replace function public.residency_replay_cron_active()
returns boolean
language sql
security definer
set search_path = public, cron
as $$
  select exists (
    select 1 from cron.job
     where jobname = 'edge-residency-replay'
       and active
  );
$$;

comment on function public.residency_replay_cron_active() is
  'True when the edge-residency-replay cron is scheduled AND active. Gate for flipping a tenant to dual/vps: without the replayer the write journal never drains, so dual replicates nothing.';

revoke all on function public.residency_replay_cron_active() from public;
grant execute on function public.residency_replay_cron_active() to service_role;
