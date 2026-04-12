-- Multiple OAuth workspace links per business (e.g. several Gmail / Microsoft accounts via Nango)
create table if not exists workspace_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  provider_config_key text not null,
  connection_id text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_oauth_connections_business_provider_connection_key
    unique (business_id, provider_config_key, connection_id)
);

create index if not exists workspace_oauth_connections_business_id_idx
  on workspace_oauth_connections (business_id);

alter table workspace_oauth_connections enable row level security;

drop policy if exists "Owner reads workspace_oauth_connections" on workspace_oauth_connections;
create policy "Owner reads workspace_oauth_connections"
  on workspace_oauth_connections for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner inserts workspace_oauth_connections" on workspace_oauth_connections;
create policy "Owner inserts workspace_oauth_connections"
  on workspace_oauth_connections for insert
  with check (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner updates workspace_oauth_connections" on workspace_oauth_connections;
create policy "Owner updates workspace_oauth_connections"
  on workspace_oauth_connections for update
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner deletes workspace_oauth_connections" on workspace_oauth_connections;
create policy "Owner deletes workspace_oauth_connections"
  on workspace_oauth_connections for delete
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- Replaced by workspace_oauth_connections (one row per connection)
delete from integrations where provider = 'nango_email';
