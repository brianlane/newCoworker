-- Slack two-way chat pipeline: the tenant's team DMs the coworker (or
-- @mentions it in a channel) and gets the same inline engine dashboard chat
-- runs. Mirrors the messenger_* pipeline (20260808010000) with one
-- deliberate difference: Slack users are the TEAM, not customers, so
-- nothing here touches contacts / record_customer_interaction.
--
-- Security posture: RLS ON with NO policies on all three tables
-- (service-role only), same as slack_connections.

create table if not exists public.slack_conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  team_id text not null,
  -- The Slack conversation id: a D… im channel for DMs, a C…/G… channel for
  -- @mention threads.
  channel_id text not null,
  -- Null for DMs (the DM itself is the thread); the mention's thread anchor
  -- (parent ts) for channel conversations.
  thread_ts text,
  slack_user_id text not null,
  user_display_name text,
  -- Verified email from users.info at first contact; how the owner is
  -- recognized (owner-power tools stay off for everyone else).
  user_email text,
  is_owner boolean not null default false,
  last_user_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One conversation per (business, channel, thread anchor, speaker): DMs key
-- on channel+user, channel threads on channel+thread+user. coalesce folds
-- the null-thread DM case into the index.
create unique index if not exists uq_slack_conversations_scope
  on public.slack_conversations (business_id, channel_id, coalesce(thread_ts, ''), slack_user_id);

alter table public.slack_conversations enable row level security;
grant select, insert, update, delete on table public.slack_conversations to service_role;

create table if not exists public.slack_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.slack_conversations(id) on delete cascade,
  business_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- Events API delivery id, unique per business: Slack redelivers at
  -- ~0/1/5 min on a slow ack, and the insert conflict (23505) is the dedupe
  -- that keeps a retry from double-replying (the telnyx_event_id trick).
  slack_event_id text,
  -- The message's ts in Slack (user messages: the event ts; assistant
  -- messages: the posted ts) — the threading anchor.
  slack_ts text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_slack_messages_event
  on public.slack_messages (business_id, slack_event_id)
  where slack_event_id is not null;

create index if not exists idx_slack_messages_conversation
  on public.slack_messages (conversation_id, id);

alter table public.slack_messages enable row level security;
grant select, insert, update, delete on table public.slack_messages to service_role;

create table if not exists public.slack_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  conversation_id uuid not null references public.slack_conversations(id) on delete cascade,
  user_message_id bigint not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'error')),
  attempts int not null default 0,
  claimed_by text,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  assistant_message_id bigint,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now()
);

create index if not exists idx_slack_jobs_status
  on public.slack_jobs (status, created_at);

alter table public.slack_jobs enable row level security;
grant select, insert, update, delete on table public.slack_jobs to service_role;

-- ---------------------------------------------------------------------
-- Atomic FOR UPDATE SKIP LOCKED claim, serialized per conversation
-- (claim_messenger_job verbatim, retargeted).
-- ---------------------------------------------------------------------
create or replace function public.claim_slack_job(p_worker_id text)
returns setof public.slack_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  select j.id into v_id
  from public.slack_jobs j
  join public.slack_conversations c on c.id = j.conversation_id
  where j.status = 'queued'
    and j.attempts < 3
    and not exists (
      select 1 from public.slack_jobs p
      where p.conversation_id = j.conversation_id
        and p.status = 'processing'
    )
  order by j.created_at
  for update of j, c skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update public.slack_jobs
  set status = 'processing',
      claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = v_id
  returning *;
end;
$$;

comment on function public.claim_slack_job is
  'Atomic FOR UPDATE SKIP LOCKED claim of the next queued Slack reply job (attempts < 3), serialized per conversation. Returns 0 or 1 row.';

revoke all on function public.claim_slack_job(text) from public;
grant execute on function public.claim_slack_job(text) to service_role;

-- ---------------------------------------------------------------------
-- Atomic completion: assistant message + conversation bump + job done +
-- supersede covered queued siblings (messenger_job_complete rationale).
-- p_slack_ts carries the posted message's ts for later thread anchoring.
-- ---------------------------------------------------------------------
create or replace function public.slack_job_complete(
  p_job_id uuid,
  p_content text,
  p_history_max_message_id bigint,
  p_slack_ts text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.slack_jobs%rowtype;
  v_msg_id bigint;
begin
  select * into v_job from public.slack_jobs where id = p_job_id for update;
  if not found then
    raise exception 'slack_job_complete: job % not found', p_job_id;
  end if;
  if v_job.status = 'done' then
    -- Idempotent replay (a reclaim raced an already-committed turn).
    return v_job.assistant_message_id;
  end if;

  insert into public.slack_messages (conversation_id, business_id, role, content, slack_ts)
  values (v_job.conversation_id, v_job.business_id, 'assistant', p_content, p_slack_ts)
  returning id into v_msg_id;

  update public.slack_conversations
     set updated_at = now()
   where id = v_job.conversation_id;

  update public.slack_jobs
     set status = 'done',
         assistant_message_id = v_msg_id,
         completed_at = now(),
         error_code = null,
         error_detail = null
   where id = p_job_id;

  update public.slack_jobs
     set status = 'done',
         completed_at = now(),
         error_code = 'superseded'
   where conversation_id = v_job.conversation_id
     and status = 'queued'
     and user_message_id <= p_history_max_message_id
     and id <> p_job_id;

  return v_msg_id;
end;
$$;

comment on function public.slack_job_complete is
  'Slack reply commit: assistant message + conversation bump + job done + supersede covered queued siblings, atomically. Replay on a done job returns the existing assistant_message_id.';

revoke all on function public.slack_job_complete(uuid, text, bigint, text) from public;
grant execute on function public.slack_job_complete(uuid, text, bigint, text) to service_role;

-- ---------------------------------------------------------------------
-- Requeue wedged claims (messenger_jobs_reclaim_stale verbatim).
-- ---------------------------------------------------------------------
create or replace function public.slack_jobs_reclaim_stale()
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_requeued int;
begin
  update public.slack_jobs
     set status = case when attempts >= 3 then 'error' else 'queued' end,
         error_code = case when attempts >= 3 then 'max_attempts' else error_code end,
         completed_at = case when attempts >= 3 then now() else completed_at end,
         claimed_by = null,
         claimed_at = null
   where status = 'processing'
     and claimed_at < now() - interval '10 minutes';
  get diagnostics v_requeued = row_count;
  return v_requeued;
end;
$$;

comment on function public.slack_jobs_reclaim_stale is
  'Requeue Slack reply jobs whose claim went stale (>10 min); max-attempts rows flip to error. Returns affected row count.';

revoke all on function public.slack_jobs_reclaim_stale() from public;
grant execute on function public.slack_jobs_reclaim_stale() to service_role;

-- ---------------------------------------------------------------------
-- Cron retry net: the webhook kicks the worker inline on every enqueue;
-- this sweep is stale-claim reclaim + anything the kick missed
-- (edge-messenger-jobs-sweep pattern).
-- ---------------------------------------------------------------------
do $unschedule$
begin
  perform cron.unschedule('edge-slack-jobs-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-slack-jobs-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-slack-jobs-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/slack-jobs-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- Must cover min(route maxDuration 300s, Supabase edge ceiling 150s):
    -- the sweep legitimately waits on a full batch of turns
    -- (tests/cron-timeout-parity.test.ts; the messenger sweep needed the
    -- same raise in 20260822065201).
    timeout_milliseconds := 150000
  );
  $$
);
