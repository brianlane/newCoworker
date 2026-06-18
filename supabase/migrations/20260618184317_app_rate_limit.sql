-- Durable, cross-instance rate limiting backed by Postgres.
--
-- The in-memory limiter in src/lib/rate-limit.ts uses a per-process Map,
-- which on Vercel serverless is per-isolate and ephemeral. This shared
-- fixed-window counter lets us enforce a limit across the whole fleet for
-- the endpoints that need it most: the unauthenticated, LLM-backed
-- onboarding chat / website preview routes, where a single IP fanned
-- across isolates could otherwise run up model spend.
--
-- Mirrors the proven telnyx_webhook_rate_check pattern. service_role-only:
-- per the public-function grant lockdown, anon/authenticated get no EXECUTE.
create table if not exists app_rate_limit (
  bucket_key text not null,
  window_epoch bigint not null,
  hit_count int not null default 0,
  primary key (bucket_key, window_epoch)
);

create index if not exists idx_app_rate_limit_prune on app_rate_limit (window_epoch);

alter table app_rate_limit enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated have no access by design.

create or replace function app_rate_limit_hit(
  p_key text,
  p_max int,
  p_window_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ws int := greatest(p_window_seconds, 1);
  w bigint := (floor(extract(epoch from clock_timestamp()) / ws) * ws)::bigint;
  cnt int;
begin
  if p_max <= 0 then
    return jsonb_build_object('ok', true, 'disabled', true);
  end if;

  insert into app_rate_limit (bucket_key, window_epoch, hit_count)
  values (md5(coalesce(nullif(trim(p_key), ''), 'unknown')), w, 1)
  on conflict (bucket_key, window_epoch)
  do update set hit_count = app_rate_limit.hit_count + 1
  returning hit_count into cnt;

  -- Opportunistic prune of stale windows (>24h old).
  delete from app_rate_limit where window_epoch < (extract(epoch from clock_timestamp())::bigint - 86400);

  return jsonb_build_object('ok', cnt <= p_max, 'hits', cnt, 'max', p_max, 'reset', (w + ws) * 1000);
end;
$$;

revoke all on function app_rate_limit_hit(text, int, int) from public, anon, authenticated;
grant execute on function app_rate_limit_hit(text, int, int) to service_role;
