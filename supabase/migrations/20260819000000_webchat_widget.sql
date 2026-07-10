-- Embeddable website chat widget (Standard+): third customer channel.
--
-- A business embeds `<script src=".../widget.js" data-key="ncw_pub_...">` on
-- its OWN website; visitors chat with a capability-restricted
-- `WebchatCoworker` agent (info + lead gen only — no SMS/email/call/image
-- tools; see the tool allowlist in src/app/api/rowboat/tool-call/route.ts and
-- the agent seed in vps/scripts/deploy-client.sh).
--
-- Reply delivery reuses the proven Option-B job-queue pattern from
-- dashboard_chat_jobs (20260508000000): the public /api/widget/message route
-- enqueues a `webchat_jobs` row and returns immediately; the per-tenant VPS
-- chat-worker claims it, calls the local Rowboat, inserts the assistant
-- message, and marks the job done. The widget POLLS /api/widget/poll (no
-- Realtime — anonymous visitors have no Supabase identity, and every table
-- here is deny-by-default).
--
-- Security posture (matches vps_gateway_tokens / vps_ssh_keys):
--   * RLS ON with NO policies on all four tables — anon/authenticated get an
--     unconditional deny; every access goes through Next.js service-role
--     routes after their own auth (widget key + per-session bearer hash).
--   * The widget public key (`ncw_pub_…`) is NOT a secret — it ships in the
--     tenant's public website HTML by design. It only identifies the tenant;
--     origin allowlisting, the per-session bearer, rate limits, and the
--     restricted tool surface are the actual controls.
--   * The per-session bearer is stored ONLY as a sha256 hash.

-- ---------------------------------------------------------------------
-- Per-business widget configuration. One row per business, minted when
-- the owner first enables the widget from Settings.
-- ---------------------------------------------------------------------
create table if not exists chat_widget_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  enabled boolean not null default false,
  -- Public site key, `ncw_pub_<64 hex>`. Plaintext BY DESIGN: it is embedded
  -- in the tenant's public website markup, so hashing it here would protect
  -- nothing. The sha256 column is the O(1) request-time lookup index.
  public_key text not null,
  public_key_sha256 text not null,
  -- Origins allowed to embed/call (e.g. https://example.com). Empty array =
  -- allow any origin (the key alone identifies the tenant); non-empty =
  -- the Origin header must match one entry exactly (scheme + host [+ port]).
  allowed_origins text[] not null default '{}',
  -- Owner toggle: require a name + email/phone form before the first
  -- message (stronger lead capture) vs. anonymous chat where the agent asks
  -- naturally during conversation.
  require_contact_form boolean not null default false,
  -- Widget theming: { accentColor, greeting, agentDisplayName }. Validated
  -- at the API layer (zod); jsonb here so new knobs don't need migrations.
  theme jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_chat_widget_settings_key_sha256
  on chat_widget_settings (public_key_sha256);

alter table chat_widget_settings enable row level security;

comment on table chat_widget_settings is
  'Embeddable website chat widget config (Standard+). RLS on, no policies: service-role only. public_key is deliberately plaintext — it ships in the tenant''s public website HTML.';

-- ---------------------------------------------------------------------
-- Visitor sessions. One row per widget conversation; the session bearer
-- (random 256-bit token, sha256-stored) scopes every subsequent
-- /api/widget/message + /api/widget/poll call to this row.
-- ---------------------------------------------------------------------
create table if not exists webchat_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  session_token_sha256 text not null,
  -- Captured lead details. Populated up front when require_contact_form is
  -- on; otherwise filled in by the webchat_capture_lead tool as the visitor
  -- volunteers them mid-conversation.
  visitor_name text,
  visitor_email text,
  visitor_phone text,
  -- Rowboat continuation (same model as sms_rowboat_threads): resume the
  -- server-side conversation when present; cleared after a successful
  -- stateless retry so a dead id doesn't cost 2x latency every turn.
  rowboat_conversation_id text,
  rowboat_state jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists uq_webchat_sessions_token_sha256
  on webchat_sessions (session_token_sha256);

-- Owner dashboard "Web chat" list: newest sessions first per business.
create index if not exists idx_webchat_sessions_business
  on webchat_sessions (business_id, created_at desc);

alter table webchat_sessions enable row level security;

comment on table webchat_sessions is
  'Website chat widget visitor sessions. RLS on, no policies: all reads/writes go through service-role routes that verified the widget key + per-session bearer (visitors) or requireBusinessRole (owners).';

-- ---------------------------------------------------------------------
-- Messages. business_id is denormalized so the per-business daily
-- message ceiling (abuse control) is one indexed count, and the owner
-- transcript view never needs a join for tenant scoping.
-- ---------------------------------------------------------------------
create table if not exists webchat_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references webchat_sessions(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  -- Client-generated idempotency key for VISITOR turns. The widget attaches
  -- a fresh UUID per send and retries a network-failed POST with the SAME
  -- id; the partial unique index below makes the replay collide, and the
  -- route returns the original message + job instead of double-enqueueing.
  -- Null for assistant/system rows (and for clients that omit it).
  client_message_id text,
  created_at timestamptz not null default now()
);

-- Poll cursor: "messages on this session with id > cursor", in order.
create index if not exists idx_webchat_messages_session
  on webchat_messages (session_id, id);

-- Idempotent send: one row per (session, client id).
create unique index if not exists uq_webchat_messages_client_id
  on webchat_messages (session_id, client_message_id)
  where client_message_id is not null;

-- Daily per-business ceiling: count of user messages since midnight.
create index if not exists idx_webchat_messages_business_created
  on webchat_messages (business_id, created_at);

alter table webchat_messages enable row level security;

comment on table webchat_messages is
  'Website chat widget transcript rows. RLS on, no policies: service-role only (widget poll route filters by verified session; owner view by requireBusinessRole).';

-- ---------------------------------------------------------------------
-- Job queue. Mirrors dashboard_chat_jobs column-for-column where the
-- semantics match; reuses the chat_job_status enum. Consumed by the
-- same per-tenant VPS chat-worker (vps/chat-worker) via a second claim
-- loop with startAgent=WebchatCoworker.
-- ---------------------------------------------------------------------
create table if not exists webchat_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  session_id uuid not null references webchat_sessions(id) on delete cascade,
  -- The visitor message that triggered this job; if the session (and its
  -- messages) are deleted the job is meaningless.
  user_message_id bigint not null references webchat_messages(id) on delete cascade,
  status chat_job_status not null default 'queued',
  attempts smallint not null default 0,
  claimed_by text,
  claimed_at timestamptz,
  assistant_message_id bigint references webchat_messages(id) on delete set null,
  -- Pre-computed Rowboat input (system preambles + bounded tail + new user
  -- turn), built by /api/widget/message so the worker stays business-logic
  -- free — same contract as dashboard_chat_jobs.input_messages.
  input_messages jsonb,
  -- Stateless-retry variant (full tail, no conversationId). Null when the
  -- first attempt is already stateless (fresh session) — no fallback.
  stateless_input_messages jsonb,
  rowboat_conversation_id text,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_webchat_jobs_queued
  on webchat_jobs (created_at)
  where status = 'queued';

create index if not exists idx_webchat_jobs_stale
  on webchat_jobs (claimed_at)
  where status = 'processing';

create index if not exists idx_webchat_jobs_session
  on webchat_jobs (session_id, created_at desc);

alter table webchat_jobs enable row level security;

comment on table webchat_jobs is
  'VPS chat-worker job queue for the website chat widget. Inserted by /api/widget/message; consumed by vps/chat-worker (startAgent=WebchatCoworker). The widget polls /api/widget/poll — it never reads this table.';

-- Worker subscribes to INSERTs for wake-up (drain loop covers misses).
alter publication supabase_realtime add table webchat_jobs;

-- ---------------------------------------------------------------------
-- RPCs — mirror claim_chat_job / reclaim_stale_chat_jobs
-- (20260508000001_dashboard_chat_jobs_rpcs.sql). FOR UPDATE SKIP LOCKED
-- claim; attempts incremented at claim time; stale-claim requeue for
-- crash recovery.
-- ---------------------------------------------------------------------
create or replace function claim_webchat_job(p_worker_id text, p_business_id uuid)
returns setof webchat_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  select id into v_id
  from webchat_jobs
  where status = 'queued' and business_id = p_business_id
  order by created_at
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update webchat_jobs
  set status = 'processing',
      claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = v_id
  returning *;
end;
$$;

create or replace function reclaim_stale_webchat_jobs(p_max_age_ms int)
returns setof webchat_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  update webchat_jobs
  set status = 'queued',
      claimed_by = null,
      claimed_at = null
  where status = 'processing'
    and claimed_at < now() - (p_max_age_ms || ' milliseconds')::interval
  returning *;
end;
$$;

comment on function claim_webchat_job is
  'Atomic FOR UPDATE SKIP LOCKED claim of the next queued webchat job for one tenant. Returns 0 or 1 row. Same contract as claim_chat_job.';

comment on function reclaim_stale_webchat_jobs is
  'Crash recovery: re-queue webchat jobs whose claimed_at is older than p_max_age_ms. Run on worker startup and every sweep tick.';

revoke all on function claim_webchat_job(text, uuid) from public;
revoke all on function reclaim_stale_webchat_jobs(int) from public;
grant execute on function claim_webchat_job(text, uuid) to service_role;
grant execute on function reclaim_stale_webchat_jobs(int) to service_role;

-- ---------------------------------------------------------------------
-- 'webchat' becomes a first-class interaction channel alongside
-- sms/voice/dashboard/email: when the widget's lead-capture tool gets a
-- coercible phone number, the visitor rolls up to the same cross-channel
-- contact profile a texter or caller would. Same widening pattern as the
-- 'email' channel (20260629000000_contacts_email.sql). The constraint
-- kept its pre-rename name when customer_memories became contacts
-- (20260704000000_contacts_unify.sql).
-- ---------------------------------------------------------------------
alter table public.contacts
  drop constraint if exists customer_memories_last_channel_check;
alter table public.contacts
  add constraint customer_memories_last_channel_check
  check (last_channel in ('sms', 'voice', 'dashboard', 'email', 'webchat'));

-- Re-declare record_customer_interaction with ONLY the channel guard
-- widened. IMPORTANT: this is byte-for-byte the alias-aware definition
-- from 20260704000000_contacts_unify.sql otherwise — the leading alias
-- UPDATE must be preserved so an interaction from a merged-away number
-- bumps the surviving profile instead of re-inserting the merged one.
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
  if p_channel not in ('sms', 'voice', 'dashboard', 'email', 'webchat') then
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
