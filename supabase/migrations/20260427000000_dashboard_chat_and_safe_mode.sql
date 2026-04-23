-- Dashboard owner-to-local-model chat + Safe Mode flag.
--
-- Safe Mode (`businesses.customer_channels_enabled`) is distinct from the kill
-- switch (`is_paused`):
--   is_paused = true               → hard stop, nothing answers
--   customer_channels_enabled=false → customer SMS/voice forwarded to owner
--                                      cell; owner /dashboard/chat stays on
--   both flags false/true (default) → normal AI operation
-- Precondition for Safe Mode: `business_telnyx_settings.forward_to_e164` set.
--
-- dashboard_chat_threads / dashboard_chat_messages persist the owner's
-- conversations with the local Rowboat+Ollama stack over the Cloudflare
-- tunnel. dashboard_chat_activity is read from the VPS keep-warm timer to
-- stand down during active owner chat.
--
-- No RLS: all reads/writes go through Next.js routes that call requireOwner().

alter table businesses
  add column if not exists customer_channels_enabled boolean not null default true;

comment on column businesses.customer_channels_enabled is
  'Safe Mode flag. When false, customer SMS/voice forwards to forward_to_e164 and the AI does not answer. Distinct from is_paused (full kill switch).';

create table if not exists dashboard_chat_threads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  rowboat_conversation_id text,
  rowboat_state jsonb,
  title text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one active thread per business. Partial unique index tolerates the
-- historical rows created by `DELETE /api/dashboard/chat` (is_active=false).
create unique index if not exists dashboard_chat_threads_one_active
  on dashboard_chat_threads (business_id)
  where is_active;

create index if not exists dashboard_chat_threads_business_idx
  on dashboard_chat_threads (business_id, created_at desc);

create table if not exists dashboard_chat_messages (
  id bigserial primary key,
  thread_id uuid not null references dashboard_chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_chat_messages_thread_idx
  on dashboard_chat_messages (thread_id, created_at);

-- last_user_chat_at is read by the VPS `keep-warm.sh` script via Supabase REST
-- using the service role key (same trust model as voice-bridge heartbeats).
create table if not exists dashboard_chat_activity (
  business_id uuid primary key references businesses(id) on delete cascade,
  last_user_chat_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
