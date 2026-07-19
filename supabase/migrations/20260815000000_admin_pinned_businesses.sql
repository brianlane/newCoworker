-- Admin clients-table pin.
--
-- Flipped from the /admin/clients table (pin icon per row), `admin_pinned`
-- keeps chosen businesses (e.g. the internal HQ tenant) at the top of the
-- list regardless of the default newest-first order or any column sort.
-- Admin-facing only — owner dashboards never read it.
alter table businesses
  add column if not exists admin_pinned boolean not null default false;

comment on column businesses.admin_pinned is
  'When true, this business is pinned to the top of the admin All Clients table.';
