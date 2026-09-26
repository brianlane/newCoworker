-- Records SQL already applied to production (ledger version 20260925224056,
-- created_by the project Supabase account). The file was missing from git, so
-- every later pull request failed the drift check with "remote migration
-- versions not found in local migrations directory."
create table if not exists public.alexa_edge_source (
  id text primary key,
  source text not null,
  updated_at timestamptz not null default now()
);
revoke all on table public.alexa_edge_source from anon, authenticated;
grant select on table public.alexa_edge_source to service_role;
