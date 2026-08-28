-- One two-way chat pipeline for every team-facing coworker channel.
--
-- This is the third copy of the same four tables and three functions. The
-- Slack pipeline (20260822113428) says so in its own header: it "mirrors the
-- messenger_* pipeline" and claim_slack_job is "claim_messenger_job
-- verbatim, retargeted". Telegram, Microsoft Teams and Google Chat would
-- have made it six. So the shape gets a `channel` column and one home, and
-- Slack moves onto it.
--
-- WHAT IS NOT HERE, deliberately: messenger_* stays where it is. WhatsApp is
-- not a separate pipeline, it is a `platform` branch inside the CUSTOMER
-- Meta pipeline, sharing messenger_conversations with Messenger and
-- Instagram, which do lead capture and write contacts. Splitting a table
-- three platforms share, to move one of them onto a team-chat pipeline it
-- does not use, would buy nothing and fork the Meta webhook.
--
-- Security posture: RLS ON with NO policies on every table (service-role
-- only), matching slack_connections and the slack_* pipeline it replaces.

-- ---------------------------------------------------------------------
-- Connections.
--
-- Slack is NOT migrated onto this table in this migration, and that is on
-- purpose. slack_connections is wired into the OAuth install, the callback,
-- the management route, the uninstall webhook and the integrations UI, and
-- moving it is a much larger blast radius than moving the chat pipeline. The
-- channel adapter owns connection loading instead, so Slack reads its own
-- table behind the same interface and a later migration can fold it in here
-- without the worker noticing.
--
-- New channels start here.
-- ---------------------------------------------------------------------
create table if not exists public.coworker_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null,
  -- The PROVIDER's own tenant boundary: a Slack team_id, a Microsoft Entra
  -- tenant id, a Google Workspace, a Telegram bot id. Inbound events carry
  -- this and nothing else, so it is how an event finds its business, and
  -- the unique index below is what stops an unbound org reaching a tenant.
  external_workspace_id text not null,
  external_workspace_name text,
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`) over whatever this
  -- channel needs to authenticate: a bot token, a refresh token, a service
  -- account. Empty string after an uninstall wipe, so the row survives and
  -- the card can say "Needs reconnect" rather than vanishing.
  credentials_encrypted text not null default '',
  -- Per-connection webhook shared secret, for the channels that authenticate
  -- their callbacks with one instead of a signature (Telegram).
  webhook_secret text,
  -- Where alerts go: a Slack channel, a Telegram chat, a Teams conversation.
  alert_target_id text,
  alert_target_name text,
  -- Soft-disable: owner pause, or automatically false on uninstall/revoke.
  is_active boolean not null default true,
  -- Dashboard user who ran the install (audit; no FK, auth users live in
  -- the auth schema).
  installed_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One connection per (business, channel): the upsert target.
create unique index if not exists uq_coworker_connections_business_channel
  on public.coworker_connections (business_id, channel);

-- And one business per (channel, workspace). This is the load-bearing one:
-- an inbound event carries only the workspace id, so without it a second
-- business could claim a workspace and start receiving another tenant's
-- conversations.
create unique index if not exists uq_coworker_connections_channel_workspace
  on public.coworker_connections (channel, external_workspace_id);

alter table public.coworker_connections enable row level security;
grant select, insert, update, delete on table public.coworker_connections to service_role;

-- ---------------------------------------------------------------------
-- Conversations.
-- ---------------------------------------------------------------------
create table if not exists public.coworker_conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null,
  external_workspace_id text,
  -- Where the conversation lives: a Slack D…/C… channel, a Telegram chat id.
  external_conversation_id text not null,
  -- Null when the conversation IS the thread (a DM); the thread anchor
  -- otherwise. Named `thread_key` rather than Slack's `thread_ts` because
  -- only Slack anchors threads on a timestamp.
  thread_key text,
  external_user_id text not null,
  user_display_name text,
  -- Verified at first contact where the channel supplies one. Slack and
  -- Google Chat carry an email, Teams resolves one; Telegram carries
  -- neither, which is why the phone column exists beside it.
  user_email text,
  user_phone_e164 text,
  is_owner boolean not null default false,
  last_user_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One conversation per (business, channel, place, thread anchor, speaker):
-- DMs key on conversation+user, threads on conversation+thread+user.
-- coalesce folds the null-thread DM case into the index.
create unique index if not exists uq_coworker_conversations_scope
  on public.coworker_conversations (
    business_id, channel, external_conversation_id, coalesce(thread_key, ''), external_user_id
  );

-- The channel-liveness read: newest human signal per business and channel.
create index if not exists idx_coworker_conversations_liveness
  on public.coworker_conversations (business_id, channel, last_user_message_at desc);

alter table public.coworker_conversations enable row level security;
grant select, insert, update, delete on table public.coworker_conversations to service_role;

-- ---------------------------------------------------------------------
-- Messages.
-- ---------------------------------------------------------------------
create table if not exists public.coworker_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.coworker_conversations(id) on delete cascade,
  business_id uuid not null,
  channel text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- The provider's delivery id. Every one of these platforms redelivers on
  -- a slow ack, and the insert conflict (23505) on the index below is the
  -- dedupe that stops a retry becoming a second reply.
  external_event_id text,
  -- The message's id in the provider (user rows: the event's; assistant
  -- rows: the posted message's), which is what later threading anchors on.
  external_ts text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_coworker_messages_event
  on public.coworker_messages (business_id, channel, external_event_id)
  where external_event_id is not null;

create index if not exists idx_coworker_messages_conversation
  on public.coworker_messages (conversation_id, id);

alter table public.coworker_messages enable row level security;
grant select, insert, update, delete on table public.coworker_messages to service_role;

-- ---------------------------------------------------------------------
-- Jobs.
-- ---------------------------------------------------------------------
create table if not exists public.coworker_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  channel text not null,
  conversation_id uuid not null references public.coworker_conversations(id) on delete cascade,
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

create index if not exists idx_coworker_jobs_status
  on public.coworker_jobs (status, created_at);

alter table public.coworker_jobs enable row level security;
grant select, insert, update, delete on table public.coworker_jobs to service_role;

-- ---------------------------------------------------------------------
-- Atomic FOR UPDATE SKIP LOCKED claim, serialized per conversation
-- (claim_slack_job retargeted, which was claim_messenger_job before that).
-- ---------------------------------------------------------------------
create or replace function public.claim_coworker_job(p_worker_id text)
returns setof public.coworker_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  select j.id into v_id
  from public.coworker_jobs j
  join public.coworker_conversations c on c.id = j.conversation_id
  where j.status = 'queued'
    and j.attempts < 3
    and not exists (
      select 1 from public.coworker_jobs p
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
  update public.coworker_jobs
  set status = 'processing',
      claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = v_id
  returning *;
end;
$$;

comment on function public.claim_coworker_job is
  'Atomic FOR UPDATE SKIP LOCKED claim of the next queued coworker reply job (attempts < 3), serialized per conversation, across every channel. Returns 0 or 1 row.';

revoke all on function public.claim_coworker_job(text) from public;
grant execute on function public.claim_coworker_job(text) to service_role;

-- ---------------------------------------------------------------------
-- Atomic completion: assistant message + conversation bump + job done +
-- supersede covered queued siblings.
-- ---------------------------------------------------------------------
create or replace function public.coworker_job_complete(
  p_job_id uuid,
  p_content text,
  p_history_max_message_id bigint,
  p_external_ts text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.coworker_jobs%rowtype;
  v_msg_id bigint;
begin
  select * into v_job from public.coworker_jobs where id = p_job_id for update;
  if not found then
    raise exception 'coworker_job_complete: job % not found', p_job_id;
  end if;
  if v_job.status = 'done' then
    -- Idempotent replay (a reclaim raced an already-committed turn).
    return v_job.assistant_message_id;
  end if;

  insert into public.coworker_messages
    (conversation_id, business_id, channel, role, content, external_ts)
  values
    (v_job.conversation_id, v_job.business_id, v_job.channel, 'assistant', p_content, p_external_ts)
  returning id into v_msg_id;

  update public.coworker_conversations
     set updated_at = now()
   where id = v_job.conversation_id;

  update public.coworker_jobs
     set status = 'done',
         assistant_message_id = v_msg_id,
         completed_at = now(),
         error_code = null,
         error_detail = null
   where id = p_job_id;

  update public.coworker_jobs
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

comment on function public.coworker_job_complete is
  'Coworker reply commit: assistant message + conversation bump + job done + supersede covered queued siblings, atomically. Replay on a done job returns the existing assistant_message_id.';

revoke all on function public.coworker_job_complete(uuid, text, bigint, text) from public;
grant execute on function public.coworker_job_complete(uuid, text, bigint, text) to service_role;

-- ---------------------------------------------------------------------
-- Requeue wedged claims.
-- ---------------------------------------------------------------------
create or replace function public.coworker_jobs_reclaim_stale()
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_requeued int;
begin
  update public.coworker_jobs
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

comment on function public.coworker_jobs_reclaim_stale is
  'Requeue coworker reply jobs whose claim went stale (>10 min); max-attempts rows flip to error. Returns affected row count.';

revoke all on function public.coworker_jobs_reclaim_stale() from public;
grant execute on function public.coworker_jobs_reclaim_stale() to service_role;

-- ---------------------------------------------------------------------
-- Backfill Slack onto the shared pipeline.
--
-- Ordered conversations then messages then jobs so the foreign keys hold,
-- and keyed on the old primary keys so a re-run is a no-op rather than a
-- duplicate. The slack_* tables are deliberately LEFT IN PLACE and left
-- readable: a rollback of the deploy that follows this is then a code
-- revert rather than a database restore. A later migration drops them once
-- this has been watched working.
-- ---------------------------------------------------------------------
insert into public.coworker_conversations (
  id, business_id, channel, external_workspace_id, external_conversation_id,
  thread_key, external_user_id, user_display_name, user_email, is_owner,
  last_user_message_at, created_at, updated_at
)
select
  c.id, c.business_id, 'slack', c.team_id, c.channel_id,
  c.thread_ts, c.slack_user_id, c.user_display_name, c.user_email, c.is_owner,
  c.last_user_message_at, c.created_at, c.updated_at
from public.slack_conversations c
on conflict (id) do nothing;

insert into public.coworker_messages (
  conversation_id, business_id, channel, role, content, external_event_id,
  external_ts, created_at
)
select
  m.conversation_id, m.business_id, 'slack', m.role, m.content, m.slack_event_id,
  m.slack_ts, m.created_at
from public.slack_messages m
-- Only messages whose conversation made it across, so the FK holds even if
-- a conversation row was deleted mid-flight.
where exists (
  select 1 from public.coworker_conversations c where c.id = m.conversation_id
)
-- All-or-nothing guard, because ON CONFLICT alone cannot make this
-- idempotent: the arbiter index is partial, so a message with no provider
-- event id (an assistant row posted without one) conflicts with nothing and
-- would be inserted again on a re-run. Measured, not assumed: without this
-- a second application took a four-message thread to five.
and not exists (
  select 1 from public.coworker_messages x where x.channel = 'slack'
)
-- ORDER BY IS LOAD-BEARING, not tidiness. coworker_messages.id is an
-- identity column, assigned in the order this SELECT produces rows, and
-- listCoworkerMessages reads a thread's history by id. Without this the
-- planner is free to return rows by the event-id index (or any other
-- order), which would replay a live thread out of chronological order and
-- leave the turn treating the wrong line as the one to answer.
order by m.id
-- The arbiter index is PARTIAL (external_event_id is not null), and a
-- partial index only arbitrates when the statement repeats its predicate.
-- Without this Postgres rejects the whole migration with "no unique or
-- exclusion constraint matching the ON CONFLICT specification".
on conflict (business_id, channel, external_event_id)
  where external_event_id is not null
  do nothing;

-- IN-FLIGHT JOBS ARE DELIBERATELY NOT COPIED, and this is the safer of two
-- imperfect options rather than an oversight.
--
-- Copying them would mint a second, independently claimable copy of work
-- the OLD worker can still finish: the migration unschedules the Slack
-- cron, but it cannot stop a webhook kick already in flight or an
-- /api/internal/slack-worker run already executing, and the app deploy is
-- not atomic with this migration. The result would be two answers to one
-- message in the workspace. A `processing` row already at attempts = 3
-- would be worse still: copied as `queued` with that counter, it can never
-- be claimed (claim takes attempts < 3) and never reclaimed (reclaim only
-- touches `processing`), so it would sit queued forever.
--
-- Not copying them costs at most a handful of in-flight messages going
-- unanswered across the cutover window. Their CONTENT is safe either way,
-- because the messages above did come across, so the thread reads
-- correctly and the next turn replays them as context. An unanswered
-- message is recoverable by asking again; a duplicate reply and a
-- permanently wedged conversation head are not.
--
-- slack_jobs stays readable, so anything stranded is visible afterwards:
--   select id, conversation_id, status, attempts, created_at
--   from public.slack_jobs where status in ('queued','processing');

-- ---------------------------------------------------------------------
-- Cron retry net. The webhook kicks the worker inline on every enqueue;
-- this sweep is stale-claim reclaim plus anything the kick missed.
--
-- Replaces edge-slack-jobs-sweep, which is unscheduled below: leaving it
-- running would point a live cron at a table the worker no longer writes,
-- which reads as a healthy sweep finding nothing to do.
-- ---------------------------------------------------------------------
do $unschedule$
begin
  perform cron.unschedule('edge-slack-jobs-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-slack-jobs-sweep'
  );
  perform cron.unschedule('edge-coworker-jobs-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-coworker-jobs-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-coworker-jobs-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/coworker-jobs-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- Must OUTLAST the chain it starts, never undercut it: the sweep waits
    -- on a full batch of turns, and a cron timeout shorter than the request
    -- hangs up on work that then completes unattributed.
    timeout_milliseconds := 150000
  );
  $$
);
