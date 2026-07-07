-- Residency Phase B4: central purge + backup-key escrow.
--
-- PURGE: for a tenant in data_residency_mode='vps' whose journal is fully
-- drained, remove replicated CONTENT HISTORY from central Supabase so it
-- rests only on the tenant's box. Central remains the write ingress (the
-- engine tables and webhooks are central by design), so content re-
-- accumulates between purges — the retention window (p_keep_hours) is the
-- disclosed "content in transit" bound, and a sweep re-runs the purge on
-- the operator's cadence.
--
-- THE CRITICAL SUBTLETY: a naive central DELETE would fire the residency
-- journal triggers, replicate as 'delete' ops, and destroy the box's copy —
-- the exact opposite of a purge. residency_purge_business() therefore sets
-- a TRANSACTION-LOCAL flag that residency_journal_row() honors, so purge
-- deletes never journal. The flag dies with the transaction; no session
-- leakage.
--
-- WHAT PURGES vs WHAT STAYS (worst-case reasoning):
--   Purged (append-only history the engine never re-reads):
--     email_log, sms_outbound_log, voice_call_transcripts (terminal states,
--     turns via FK cascade), voice_outbound_dial_log, read notifications,
--     terminal scheduled_sms, answered sms_owner_reply_prompts.
--   Kept central (LIVE records the engine/UX reads on the hot path):
--     contacts (customer memory injected into every SMS/voice turn),
--     sms_rowboat_threads (conversation continuity), dashboard_chat_*
--     (owner chat context), ai_flows + aiflow_url_memory (flow engine).
--     These flip only when the engine's own reads are residency-routed —
--     purging them today would lobotomize the coworker.
--
-- GUARDS (fail closed, in order):
--   * tenant must be tier=enterprise AND data_residency_mode='vps'
--   * journal must be EMPTY for the business — pending rows mean the box
--     copy is behind, and purging unreplicated content is data loss.
--
-- BACKUP-KEY ESCROW: per-tenant passphrase for the box's encrypted
-- datastore dumps. The box encrypts locally and only ciphertext ever
-- leaves it; the passphrase lives here (service-role-only) so a dead box
-- is still restorable. This is a disclosed custody trade (same posture as
-- vps_gateway_tokens): a deal wanting zero central escrow rotates the key
-- out and owns DR themselves.

create table if not exists public.residency_backup_keys (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  passphrase text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

alter table public.residency_backup_keys enable row level security;
-- Service-role only: RLS on, no policies.

comment on table public.residency_backup_keys is
  'Escrowed passphrases for per-box encrypted residency datastore dumps. Box encrypts locally; central stores ciphertext + this key so a dead box stays restorable. Disclosed custody trade, rotatable per deal.';

-- ── journal trigger learns the purge mute ────────────────────────────────
create or replace function public.residency_journal_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_business uuid;
  v_mode text;
begin
  -- Transaction-local purge mute (set by residency_purge_business): purge
  -- deletes must not replicate to the box as content deletes.
  if current_setting('app.residency_purge', true) = 'true' then
    return null;
  end if;

  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  if tg_table_name = 'dashboard_chat_messages' then
    select t.business_id into v_business
      from public.dashboard_chat_threads t
     where t.id = (v_row->>'thread_id')::uuid;
  elsif tg_table_name = 'voice_call_transcript_turns' then
    select t.business_id into v_business
      from public.voice_call_transcripts t
     where t.id = (v_row->>'transcript_id')::uuid;
  else
    v_business := (v_row->>'business_id')::uuid;
  end if;

  if v_business is null then
    return null;
  end if;

  select b.data_residency_mode into v_mode
    from public.businesses b
   where b.id = v_business;

  if v_mode is null or v_mode = 'supabase' then
    return null;
  end if;

  insert into public.residency_write_journal (business_id, table_name, op, payload)
  values (
    v_business,
    tg_table_name,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    v_row
  );

  return null;
end;
$$;

-- ── the purge ───────────────────────────────────────────────────────────
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
  if p_keep_hours < 0 then
    raise exception 'residency_purge_business: p_keep_hours must be >= 0';
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
      'residency_purge_business: % pending journal rows — drain before purging (unreplicated content would be lost)',
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

  -- Read notifications only — unread ones still drive the dashboard badge.
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
