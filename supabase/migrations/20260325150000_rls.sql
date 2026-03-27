-- Enable Row Level Security
alter table businesses enable row level security;
alter table business_configs enable row level security;
alter table coworker_logs enable row level security;
alter table sessions enable row level security;
alter table notifications enable row level security;
alter table subscriptions enable row level security;

-- Businesses: owner can read/write their own row; service role bypasses RLS
drop policy if exists "Owner reads own business" on businesses;
create policy "Owner reads own business"
  on businesses for select
  using (owner_email = auth.email());

drop policy if exists "Owner inserts own business" on businesses;
create policy "Owner inserts own business"
  on businesses for insert
  with check (owner_email = auth.email());

drop policy if exists "Owner updates own business" on businesses;
create policy "Owner updates own business"
  on businesses for update
  using (owner_email = auth.email());

-- Business configs: tied to business ownership
drop policy if exists "Owner reads own config" on business_configs;
create policy "Owner reads own config"
  on business_configs for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner writes own config" on business_configs;
create policy "Owner writes own config"
  on business_configs for insert
  with check (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner updates own config" on business_configs;
create policy "Owner updates own config"
  on business_configs for update
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- Coworker logs: owner can read their own logs
drop policy if exists "Owner reads own logs" on coworker_logs;
create policy "Owner reads own logs"
  on coworker_logs for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- Service role inserts logs (OpenClaw via service key)
drop policy if exists "Service inserts logs" on coworker_logs;
create policy "Service inserts logs"
  on coworker_logs for insert
  with check (auth.role() = 'service_role');

-- Sessions: owner reads own
drop policy if exists "Owner reads own sessions" on sessions;
create policy "Owner reads own sessions"
  on sessions for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- Notifications: owner reads own
drop policy if exists "Owner reads own notifications" on notifications;
create policy "Owner reads own notifications"
  on notifications for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- Subscriptions: owner reads own
drop policy if exists "Owner reads own subscription" on subscriptions;
create policy "Owner reads own subscription"
  on subscriptions for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );
