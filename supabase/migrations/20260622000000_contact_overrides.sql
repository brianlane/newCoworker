-- Per-number contact name overrides for the dashboard.
--
-- Why: contact resolution derives names from the roster, customer profiles,
-- and the business owner fields — but some numbers belong to people or
-- services none of those describe. Live examples: the Safe Mode forward
-- cell belongs to Amy while businesses.owner_name is Brian (one owner_name
-- cannot label two different cells), and lead sources text from short codes
-- (ReferralExchange = 73339) that have no profile at all. An override is a
-- manual, owner-set label that wins over every derived name.
--
-- `e164` accepts a real E.164 number OR a bare 3-8 digit short code —
-- short-code senders are exactly the rows that need manual labels.

create table if not exists contact_overrides (
  business_id uuid not null references businesses(id) on delete cascade,
  e164 text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, e164)
);

alter table contact_overrides
  add constraint contact_overrides_e164_chk
  check (e164 ~ '^(\+[1-9][0-9]{6,15}|[0-9]{3,8})$');

alter table contact_overrides
  add constraint contact_overrides_name_chk
  check (length(trim(name)) between 1 and 120);

alter table contact_overrides enable row level security;

drop policy if exists "Owner reads own contact overrides" on contact_overrides;
create policy "Owner reads own contact overrides"
  on contact_overrides for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner inserts own contact overrides" on contact_overrides;
create policy "Owner inserts own contact overrides"
  on contact_overrides for insert
  with check (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner updates own contact overrides" on contact_overrides;
create policy "Owner updates own contact overrides"
  on contact_overrides for update
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

drop policy if exists "Owner deletes own contact overrides" on contact_overrides;
create policy "Owner deletes own contact overrides"
  on contact_overrides for delete
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

comment on table contact_overrides is
  'Owner-set display names for phone numbers/short codes; wins over derived contact names (owner/employee/customer) in dashboard display.';
