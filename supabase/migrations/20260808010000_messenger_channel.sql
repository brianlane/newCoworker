-- Messenger + Instagram DM conversation channel.
--
-- Leads who message a connected Facebook Page (or its linked Instagram
-- professional account) get answered by the platform's Gemini engine —
-- the same persona/spend-capped surface as the website chat widget.
-- Inbound events arrive on the existing signature-verified Meta webhook
-- (/api/webhooks/meta) as entry[].messaging[] items; replies go out via
-- the Messenger Send API using the page token already stored encrypted in
-- meta_connections.
--
-- Follows the webchat write-and-queue pattern (20260710213855 +
-- 20260805000100): idempotent inbound write (unique Meta message `mid`),
-- a jobs table with claim/complete RPCs, and a cron sweep for retries.
--
-- Security posture: RLS ON with NO policies on all three tables —
-- service-role only, same as webchat_sessions (see README "RLS enabled,
-- no policies").

-- ---------------------------------------------------------------------
-- meta_connections learns about the Page's linked Instagram account
-- (captured at page-pick time via /{page}?fields=instagram_business_account)
-- so instagram-object webhook entries can be resolved to a tenant.
-- ---------------------------------------------------------------------
alter table public.meta_connections
  add column if not exists instagram_account_id text,
  add column if not exists instagram_username text;

comment on column public.meta_connections.instagram_account_id is
  'IG professional account linked to the connected Page (null when none). Webhook entries with object=instagram resolve tenants through this.';

-- One tenant per IG account, mirroring uq_meta_connections_page.
create unique index if not exists uq_meta_connections_instagram
  on public.meta_connections (instagram_account_id)
  where instagram_account_id is not null;

-- ---------------------------------------------------------------------
-- Conversations: one row per (business, page, platform, lead PSID).
-- last_user_message_at is the Meta 24-hour-window clock — sends are
-- refused once it is older than 24h (policy), so it must be bumped on
-- every inbound user message.
-- ---------------------------------------------------------------------
create table if not exists public.messenger_conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  page_id text not null,
  platform text not null check (platform in ('messenger', 'instagram')),
  -- Page-scoped (Messenger) or IG-scoped (Instagram) user id of the lead.
  psid text not null,
  display_name text,
  -- Captured by the lead-capture tool mid-conversation; enables SMS
  -- follow-ups outside the 24h window.
  contact_phone text,
  status text not null default 'active' check (status in ('active', 'closed')),
  last_user_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_messenger_conversations_identity
  on public.messenger_conversations (business_id, page_id, platform, psid);

create index if not exists idx_messenger_conversations_business_recent
  on public.messenger_conversations (business_id, last_user_message_at desc);

alter table public.messenger_conversations enable row level security;

comment on table public.messenger_conversations is
  'Messenger/Instagram DM conversations with a connected Page. RLS on, no policies: service-role only.';

-- ---------------------------------------------------------------------
-- Messages. `mid` is Meta's message id — unique per business so webhook
-- redeliveries dedupe at the INSERT (null for assistant/owner sends).
-- ---------------------------------------------------------------------
create table if not exists public.messenger_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.messenger_conversations(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'owner')),
  content text not null,
  mid text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_messenger_messages_mid
  on public.messenger_messages (business_id, mid)
  where mid is not null;

create index if not exists idx_messenger_messages_conversation
  on public.messenger_messages (conversation_id, id);

alter table public.messenger_messages enable row level security;

comment on table public.messenger_messages is
  'Messenger/Instagram DM transcript rows. RLS on, no policies: service-role only. mid dedupes Meta webhook redeliveries.';

-- ---------------------------------------------------------------------
-- Reply jobs (one per inbound user message). The internal worker
-- (/api/internal/messenger-worker) claims and answers them; a completed
-- turn supersedes older queued jobs for the same conversation whose
-- message the reply already covered (rapid multi-message leads get ONE
-- coherent reply, not one per message).
-- ---------------------------------------------------------------------
create table if not exists public.messenger_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid not null references public.messenger_conversations(id) on delete cascade,
  user_message_id bigint not null references public.messenger_messages(id) on delete cascade,
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

create index if not exists idx_messenger_jobs_queued
  on public.messenger_jobs (created_at)
  where status = 'queued';

create index if not exists idx_messenger_jobs_conversation
  on public.messenger_jobs (conversation_id, created_at);

alter table public.messenger_jobs enable row level security;

comment on table public.messenger_jobs is
  'Reply queue for Messenger/Instagram DM turns. RLS on, no policies: service-role only.';

-- ---------------------------------------------------------------------
-- Atomic claim of the next queued job (any tenant — the worker is a
-- platform surface). Jobs at max attempts are flipped to error rather
-- than claimed, so a poison message can never wedge the queue.
--
-- ONE turn per conversation at a time: concurrent worker invocations
-- (the webhook's inline kick racing the cron sweep) must never both
-- answer the same conversation, or the lead gets two AI replies. Two
-- guards enforce it: candidates whose conversation already has a
-- 'processing' job are excluded, and the conversation row itself is
-- locked (FOR UPDATE ... SKIP LOCKED) so two claims racing BEFORE
-- either commit serialize on the conversation — the loser skips the
-- candidate instead of double-claiming.
-- ---------------------------------------------------------------------
create or replace function public.claim_messenger_job(p_worker_id text)
returns setof public.messenger_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  select j.id into v_id
  from public.messenger_jobs j
  join public.messenger_conversations c on c.id = j.conversation_id
  where j.status = 'queued'
    and j.attempts < 3
    and not exists (
      select 1 from public.messenger_jobs p
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
  update public.messenger_jobs
  set status = 'processing',
      claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = v_id
  returning *;
end;
$$;

comment on function public.claim_messenger_job is
  'Atomic FOR UPDATE SKIP LOCKED claim of the next queued Messenger reply job (attempts < 3), serialized per conversation (skips conversations with a processing job; locks the conversation row against racing claims). Returns 0 or 1 row.';

revoke all on function public.claim_messenger_job(text) from public;
grant execute on function public.claim_messenger_job(text) to service_role;

-- ---------------------------------------------------------------------
-- Atomic completion: assistant message + conversation bump + job done +
-- supersede older queued siblings, one transaction (webchat's
-- webchat_job_complete_platform rationale — partial states would make
-- the stale-claim reclaim double-reply and double-bill).
--
-- p_history_max_message_id: the newest message id the engine actually
-- saw. Only queued sibling jobs at or below it are superseded — a
-- message that raced in AFTER the history read keeps its job and gets
-- its own reply.
-- ---------------------------------------------------------------------
create or replace function public.messenger_job_complete(
  p_job_id uuid,
  p_content text,
  p_history_max_message_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.messenger_jobs%rowtype;
  v_msg_id bigint;
begin
  select * into v_job from public.messenger_jobs where id = p_job_id for update;
  if not found then
    raise exception 'messenger_job_complete: job % not found', p_job_id;
  end if;
  if v_job.status = 'done' then
    -- Idempotent replay (a reclaim raced an already-committed turn).
    return v_job.assistant_message_id;
  end if;

  insert into public.messenger_messages (conversation_id, business_id, role, content)
  values (v_job.conversation_id, v_job.business_id, 'assistant', p_content)
  returning id into v_msg_id;

  update public.messenger_conversations
     set updated_at = now()
   where id = v_job.conversation_id;

  update public.messenger_jobs
     set status = 'done',
         assistant_message_id = v_msg_id,
         completed_at = now(),
         error_code = null,
         error_detail = null
   where id = p_job_id;

  -- One coherent reply covered every message up to the history cutoff:
  -- retire the sibling jobs it answered.
  update public.messenger_jobs
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

comment on function public.messenger_job_complete is
  'Messenger reply commit: assistant message + conversation bump + job done + supersede covered queued siblings, atomically. Replay on a done job returns the existing assistant_message_id.';

revoke all on function public.messenger_job_complete(uuid, text, bigint) from public;
grant execute on function public.messenger_job_complete(uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------------
-- Requeue wedged claims (worker crashed mid-turn). Claims older than 10
-- minutes go back to queued; rows already at max attempts flip to error
-- so they stop cycling. Invoked by the sweep before claiming.
-- ---------------------------------------------------------------------
create or replace function public.messenger_jobs_reclaim_stale()
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_requeued int;
begin
  update public.messenger_jobs
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

comment on function public.messenger_jobs_reclaim_stale is
  'Requeue Messenger reply jobs whose claim went stale (>10 min); max-attempts rows flip to error. Returns affected row count.';

revoke all on function public.messenger_jobs_reclaim_stale() from public;
grant execute on function public.messenger_jobs_reclaim_stale() to service_role;

-- ---------------------------------------------------------------------
-- 'messenger' becomes a first-class interaction channel alongside
-- sms/voice/dashboard/email/webchat — the lead-capture tool rolls a
-- captured phone number up to the same cross-channel contact profile.
-- Same widening pattern as 'webchat' (20260710213855).
-- ---------------------------------------------------------------------
alter table public.contacts
  drop constraint if exists customer_memories_last_channel_check;
alter table public.contacts
  add constraint customer_memories_last_channel_check
  check (last_channel in ('sms', 'voice', 'dashboard', 'email', 'webchat', 'messenger'));

-- Byte-for-byte the alias-aware definition from 20260710213855 with ONLY
-- the channel guard widened (the leading alias UPDATE must be preserved).
create or replace function public.record_customer_interaction(
  p_business_id uuid,
  p_customer_e164 text,
  p_channel text,
  p_display_name text default null
)
returns public.contacts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.contacts;
begin
  if p_channel not in ('sms', 'voice', 'dashboard', 'email', 'webchat', 'messenger') then
    raise exception 'record_customer_interaction: invalid channel %', p_channel;
  end if;

  -- Alias resolution first: an interaction from a merged-away number must bump
  -- the surviving profile, not recreate the merged one.
  update public.contacts
     set interaction_count = contacts.interaction_count + 1,
         total_interaction_count = contacts.total_interaction_count + 1,
         last_interaction_at = now(),
         last_channel = p_channel,
         display_name = coalesce(contacts.display_name, p_display_name),
         updated_at = now()
   where business_id = p_business_id
     and alias_e164s @> array[p_customer_e164]
  returning * into result;
  if found then
    return result;
  end if;

  insert into public.contacts (
    business_id, customer_e164, display_name,
    interaction_count, total_interaction_count,
    last_interaction_at, last_channel
  ) values (
    p_business_id, p_customer_e164, p_display_name,
    1, 1,
    now(), p_channel
  )
  on conflict (business_id, customer_e164) do update
    set interaction_count = contacts.interaction_count + 1,
        total_interaction_count = contacts.total_interaction_count + 1,
        last_interaction_at = now(),
        last_channel = excluded.last_channel,
        display_name = coalesce(contacts.display_name, excluded.display_name),
        updated_at = now()
  returning * into result;

  return result;
end;
$$;

revoke all on function public.record_customer_interaction(uuid, text, text, text) from public;
grant execute on function public.record_customer_interaction(uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------
-- Cron: sweep the reply queue every minute (retries + anything the
-- webhook's inline fire-and-forget kick missed). Same bridge pattern as
-- the other Edge crons.
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-messenger-jobs-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-messenger-jobs-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-messenger-jobs-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/messenger-jobs-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
