-- Per-business Cal.com connections (first-party OAuth, no Nango).
--
-- The owner authorizes the "New Coworker OAuth" client through
-- /api/integrations/cal/connect. The callback stores the token pair here.
-- Access tokens are short-lived; refresh tokens are persisted and
-- src/lib/cal/client.ts refreshes them.
--
-- Security posture matches zoom_connections: RLS on with no policies
-- (service-role only), tokens AES-256-GCM encrypted at rest.

create table public.cal_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  token_expires_at timestamptz not null,
  cal_user_id text,
  account_email text,
  account_name text,
  username text,
  time_zone text,
  default_event_type_id text,
  webhook_id text,
  webhook_secret_encrypted text,
  webhook_verification_token text not null,
  is_active boolean not null default true,
  needs_reauth boolean not null default false,
  last_healthy_at timestamptz,
  reauth_email_count integer not null default 0,
  reauth_email_last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index uq_cal_connections_business
  on public.cal_connections (business_id);

create index idx_cal_connections_needs_reauth
  on public.cal_connections (business_id)
  where needs_reauth = true;

alter table public.cal_connections enable row level security;

grant select, insert, update, delete on table public.cal_connections to service_role;
