-- Clinic sheet reader: the first successful read of a tab is a baseline,
-- and each phone on a sheet is handed to the call flow once.
--
-- clinic_sheet_baselines claims the baseline. ready stays false until every
-- phone already on the tab is stored. A second poll that sees ready = false
-- finishes that baseline and does not call. Only ready = true means later
-- rows are new patients.
-- clinic_sheet_seen_phones is the per-sheet phone ledger. A later edit of
-- a row that was already sent does not place a second call.
--
-- Service-role only. The reader runs in the Next.js cron route.

create table public.clinic_sheet_baselines (
  spreadsheet_id text not null,
  sheet_gid integer not null,
  ready boolean not null default false,
  baselined_at timestamptz not null default now(),
  primary key (spreadsheet_id, sheet_gid)
);

create table public.clinic_sheet_seen_phones (
  spreadsheet_id text not null,
  phone_e164 text not null,
  seen_at timestamptz not null default now(),
  primary key (spreadsheet_id, phone_e164)
);

alter table public.clinic_sheet_baselines enable row level security;
alter table public.clinic_sheet_seen_phones enable row level security;

grant select, insert, update, delete on table public.clinic_sheet_baselines to service_role;
grant select, insert, update, delete on table public.clinic_sheet_seen_phones to service_role;
