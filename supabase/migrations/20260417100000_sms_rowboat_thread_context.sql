-- Multi-turn SMS: persist Rowboat conversation + workflow state per business + customer E.164.

create table if not exists sms_rowboat_threads (
  business_id uuid not null references businesses(id) on delete cascade,
  customer_e164 text not null,
  rowboat_conversation_id text not null,
  rowboat_state jsonb,
  updated_at timestamptz not null default now(),
  primary key (business_id, customer_e164)
);

create index if not exists idx_sms_rowboat_threads_updated on sms_rowboat_threads (updated_at desc);

alter table sms_rowboat_threads enable row level security;

create policy "Service role manages sms_rowboat_threads"
  on sms_rowboat_threads for all
  using (auth.role() = 'service_role');

create policy "Owner reads own sms_rowboat_threads"
  on sms_rowboat_threads for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );
