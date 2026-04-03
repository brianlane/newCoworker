-- Kill switch on businesses
alter table businesses add column if not exists is_paused boolean not null default false;

-- Per-business OAuth / API key integrations
create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  provider text not null,
  auth_type text not null check (auth_type in ('oauth', 'api_key')),
  status text not null default 'disconnected' check (
    status in ('connected', 'disconnected', 'expired', 'error')
  ),
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  api_key_encrypted text,
  scopes text[],
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, provider)
);

create index if not exists integrations_business_id_idx on integrations (business_id);

-- Notification preferences per business
create table if not exists notification_preferences (
  business_id uuid primary key references businesses(id) on delete cascade,
  sms_urgent boolean not null default true,
  email_digest boolean not null default true,
  email_urgent boolean not null default true,
  dashboard_alerts boolean not null default true,
  phone_number text,
  alert_email text,
  updated_at timestamptz not null default now()
);

-- RLS
alter table integrations enable row level security;
alter table notification_preferences enable row level security;

drop policy if exists "Owner reads own integrations" on integrations;
create policy "Owner reads own integrations"
  on integrations for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner inserts own integrations" on integrations;
create policy "Owner inserts own integrations"
  on integrations for insert
  with check (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner updates own integrations" on integrations;
create policy "Owner updates own integrations"
  on integrations for update
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner deletes own integrations" on integrations;
create policy "Owner deletes own integrations"
  on integrations for delete
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner reads own notification preferences" on notification_preferences;
create policy "Owner reads own notification preferences"
  on notification_preferences for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner inserts own notification preferences" on notification_preferences;
create policy "Owner inserts own notification preferences"
  on notification_preferences for insert
  with check (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner updates own notification preferences" on notification_preferences;
create policy "Owner updates own notification preferences"
  on notification_preferences for update
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );
