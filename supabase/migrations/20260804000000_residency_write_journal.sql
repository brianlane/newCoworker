-- Residency dual-write journal (Phase B2).
--
-- Change-data-capture for the enterprise data-residency program: AFTER
-- triggers on every moved content table journal the full row image here
-- whenever the owning business has data_residency_mode past 'supabase'.
-- A cron-driven replayer (Edge residency-replay → Next.js
-- /api/internal/residency-replay) drains the journal to the tenant's
-- box-local data API in seq order.
--
-- WHY triggers instead of call-site dual-writes: the moved tables are
-- written from dozens of places (dashboard routes, three Edge workers,
-- SQL RPCs, sweeps). A wrapper approach can miss a writer forever and
-- silently diverge — the worst possible failure for a residency migration,
-- because cutover then purges the only good copy. Triggers catch every
-- writer by construction. Cost: one businesses PK lookup per write to a
-- moved table (microseconds), paid by all tenants; the journal INSERT is
-- only paid by residency tenants.
--
-- WORST-CASE posture:
--   * Box down for days  → journal grows; replay resumes where it left off.
--   * Replay failure     → per-business drain STOPS at the failing row
--                          (ordering preserved); attempts/last_error kept.
--   * Mode flipped back  → trigger stops journaling (gate re-checked per
--                          write); the replayer marks leftovers skipped.
--   * Journal is control-plane METADATA + in-flight content. Rows are
--     deleted after confirmed replay (see the replayer) so central holds
--     residency content only in transit, not at rest.

create table if not exists public.residency_write_journal (
  seq bigint generated always as identity primary key,
  business_id uuid not null,
  table_name text not null,
  -- 'upsert' carries to_jsonb(NEW) (INSERT and UPDATE collapse to a PK
  -- upsert on the box — last-writer-wins per row, replayed in seq order);
  -- 'delete' carries to_jsonb(OLD) (the replayer extracts the PK).
  op text not null check (op in ('upsert', 'delete')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  replayed_at timestamptz
);

-- Drain path: per-business, oldest-first, pending only.
create index if not exists residency_write_journal_pending_idx
  on public.residency_write_journal (business_id, seq)
  where replayed_at is null;

alter table public.residency_write_journal enable row level security;
-- Service-role only (RLS on, no policies) — same posture as vps_gateway_tokens.

comment on table public.residency_write_journal is
  'CDC journal for enterprise data residency: every write to a moved content table for a residency tenant lands here and is replayed to the tenant box data API in seq order. Rows are deleted after confirmed replay (content in transit only).';

-- ── trigger function ────────────────────────────────────────────────────
-- One generic function for all moved tables. Child tables without a
-- business_id column resolve it through their parent (kept in lockstep
-- with RESIDENCY_MOVED_TABLES in src/lib/residency/tables.ts).
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

  -- Orphan rows (parent already gone on cascade) have nothing to attribute;
  -- the parent's own delete journals the subtree removal on the box side
  -- via its FK cascade there.
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

-- ── attach to every moved table ─────────────────────────────────────────
do $attach$
declare
  t text;
begin
  foreach t in array array[
    'contacts',
    'dashboard_chat_threads',
    'dashboard_chat_messages',
    'dashboard_chat_activity',
    'email_log',
    'voice_call_transcripts',
    'voice_call_transcript_turns',
    'voice_outbound_dial_log',
    'sms_outbound_log',
    'sms_rowboat_threads',
    'sms_owner_reply_prompts',
    'scheduled_sms',
    'notifications',
    'ai_flows',
    'aiflow_url_memory'
  ]
  loop
    execute format('drop trigger if exists residency_journal on public.%I', t);
    execute format(
      'create trigger residency_journal
         after insert or update or delete on public.%I
         for each row execute function public.residency_journal_row()',
      t
    );
  end loop;
end
$attach$;

-- ── replay helpers ──────────────────────────────────────────────────────
-- Distinct businesses with pending journal rows (PostgREST cannot GROUP BY;
-- pulling every pending row client-side just to dedupe ids would make the
-- replayer's own read cost proportional to the backlog it is draining).
create or replace function public.residency_pending_businesses()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select distinct business_id
    from public.residency_write_journal
   where replayed_at is null;
$$;

revoke all on function public.residency_pending_businesses() from public;
grant execute on function public.residency_pending_businesses() to service_role;

-- Attempt counter bump for a failed batch, one statement (PostgREST cannot
-- express `set attempts = attempts + 1`).
create or replace function public.residency_bump_attempts(p_seqs bigint[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.residency_write_journal
     set attempts = attempts + 1
   where seq = any(p_seqs);
$$;

revoke all on function public.residency_bump_attempts(bigint[]) from public;
grant execute on function public.residency_bump_attempts(bigint[]) to service_role;

-- One-time backfill: snapshot every existing content row for a business
-- into the journal as 'upsert' rows, in FK-dependency order (parents before
-- children; ai_flows before voice_outbound_dial_log which references it),
-- so the ordinary replay drain moves history and live tail through ONE
-- code path with ONE ordering guarantee. Idempotent in effect: replays are
-- PK upserts, so re-running just rewrites identical rows.
create or replace function public.residency_backfill_business(p_business uuid)
returns table (table_name text, journaled bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'contacts',
    'dashboard_chat_threads',
    'dashboard_chat_messages',
    'dashboard_chat_activity',
    'email_log',
    'voice_call_transcripts',
    'voice_call_transcript_turns',
    'sms_outbound_log',
    'sms_rowboat_threads',
    'sms_owner_reply_prompts',
    'scheduled_sms',
    'notifications',
    'ai_flows',
    'voice_outbound_dial_log',
    'aiflow_url_memory'
  ]
  loop
    if t = 'dashboard_chat_messages' then
      insert into public.residency_write_journal (business_id, table_name, op, payload)
      select p_business, t, 'upsert', to_jsonb(m)
        from public.dashboard_chat_messages m
        join public.dashboard_chat_threads th on th.id = m.thread_id
       where th.business_id = p_business
       order by m.created_at;
    elsif t = 'voice_call_transcript_turns' then
      insert into public.residency_write_journal (business_id, table_name, op, payload)
      select p_business, t, 'upsert', to_jsonb(x)
        from public.voice_call_transcript_turns x
        join public.voice_call_transcripts vt on vt.id = x.transcript_id
       where vt.business_id = p_business
       order by x.id;
    else
      execute format(
        'insert into public.residency_write_journal (business_id, table_name, op, payload)
         select $1, %L, ''upsert'', to_jsonb(s) from public.%I s where s.business_id = $1',
        t, t
      ) using p_business;
    end if;
    get diagnostics n = row_count;
    table_name := t;
    journaled := n;
    return next;
  end loop;
end;
$$;

revoke all on function public.residency_backfill_business(uuid) from public;
grant execute on function public.residency_backfill_business(uuid) to service_role;

-- ── replay cron ─────────────────────────────────────────────────────────
-- Every minute (worst-case replication lag ≈60s + function runtime), same
-- bridge pattern as the other Edge crons. Secrets already in Vault.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-residency-replay')
  where exists (
    select 1 from cron.job where jobname = 'edge-residency-replay'
  );
end
$unschedule$;

select cron.schedule(
  'edge-residency-replay',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/residency-replay',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $$
);
