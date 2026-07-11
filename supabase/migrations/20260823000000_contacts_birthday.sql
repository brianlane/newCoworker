-- ---------------------------------------------------------------------------
-- contacts.birthday: drives the AiFlow `birthday` trigger channel.
--
-- A plain DATE the owner sets on the contact page (or a CSV import maps).
-- The worker's cron sweep fires enabled birthday flows once per contact per
-- year when the local date (trigger timezone, default business timezone)
-- matches — see supabase/functions/_shared/ai_flows/birthday.ts. Contacts
-- with a placeholder year still work: only month/day drive the firing, and
-- {{trigger.age}} is omitted when the year is implausible.
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column if not exists birthday date;

-- The sweep scans "every contact with a birthday" per business; partial
-- index keeps it cheap (most contacts have none).
create index if not exists contacts_birthday_idx
  on public.contacts (business_id)
  where birthday is not null;

comment on column public.contacts.birthday is
  'Optional birth date (owner-set). Month/day fire the AiFlow birthday trigger once per year; the year only feeds {{trigger.age}} and may be a placeholder.';
