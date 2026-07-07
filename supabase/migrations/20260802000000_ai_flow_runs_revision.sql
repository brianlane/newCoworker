-- Optimistic-concurrency revision counter for ai_flow_runs.
--
-- The inbound webhook's claim paths (live claim, pass, late claim,
-- first-to-claim yank, unclaim) gate their writes so the FIRST writer wins
-- when two teammates reply at once. Until now the gate compared updated_at
-- string-for-string, which silently depends on (a) every writer remembering
-- to bump updated_at and (b) timestamptz round-tripping through PostgREST
-- byte-identically. A monotonic integer has neither caveat.
--
-- The trigger bumps revision on EVERY update — writers don't opt in, so a
-- forgetful code path can never leave the counter stale the way it could
-- leave updated_at stale.
alter table public.ai_flow_runs
  add column if not exists revision integer not null default 0;

create or replace function public.bump_ai_flow_runs_revision()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.revision := old.revision + 1;
  return new;
end;
$$;

drop trigger if exists ai_flow_runs_bump_revision on public.ai_flow_runs;
create trigger ai_flow_runs_bump_revision
  before update on public.ai_flow_runs
  for each row
  execute function public.bump_ai_flow_runs_revision();
