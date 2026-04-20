-- Schedule Edge function workers via pg_cron + pg_net.
--
-- Three scheduled jobs:
--   1. sms-inbound-worker      — every minute    (processes pending SMS → Rowboat)
--   2. voice-settlement-sweep  — every 5 minutes (settles completed voice sessions)
--   3. voice-low-balance-alerts — hourly at :05  (sends per-business low-balance emails)
--
-- Each job POSTs to the corresponding Edge function with
--   Authorization: Bearer <INTERNAL_CRON_SECRET>
-- as required by `supabase/functions/_shared/cron_auth.ts`.
--
-- Security model
-- --------------
-- We deliberately DO NOT embed the Bearer secret in this SQL (migrations land
-- in git and would leak it). The secret is read at schedule-execution time
-- from Supabase Vault (pgsodium-backed `vault.decrypted_secrets` view).
--
-- One-time setup (out of band, so the values never land in git):
--
--   insert into vault.secrets (name, secret) values
--     ('internal_cron_secret', '<INTERNAL_CRON_SECRET>'),
--     ('edge_base_url', 'https://<project-ref>.supabase.co')
--   on conflict (name) do update set secret = excluded.secret;
--
-- Managed Postgres forbids `alter database postgres set` on custom GUCs, which
-- is why Vault is the right home for these values on hosted Supabase.
--
-- If either Vault secret is missing when a job fires, `net.http_post` receives
-- an empty header / URL and the Edge function returns 401. That is fail-safe
-- — no work runs until an operator finishes the setup — but the NOTICE below
-- flags it loudly during migration apply.

-- ──────────────────────────────────────────────────────────
-- Prereqs: pg_cron + pg_net are enabled on Supabase by default on Pro/Team.
-- ──────────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ──────────────────────────────────────────────────────────
-- Idempotency: unschedule any prior copy of these jobs before re-scheduling,
-- so re-applying this migration (or amending schedules) never double-fires.
-- ──────────────────────────────────────────────────────────
do $unschedule$
declare
  job_name text;
begin
  foreach job_name in array array[
    'edge-sms-inbound-worker',
    'edge-voice-settlement-sweep',
    'edge-voice-low-balance-alerts'
  ] loop
    perform cron.unschedule(job_name)
    where exists (
      select 1 from cron.job where jobname = job_name
    );
  end loop;
end
$unschedule$;

-- ──────────────────────────────────────────────────────────
-- Helpers: read Vault secrets by name with a safe empty-string fallback.
-- Declared with SECURITY DEFINER so cron jobs running as `postgres` can read
-- them without granting direct SELECT on vault.* to the role that enqueues.
-- Returns empty string (never null) so `Bearer ' || ...` is always a valid
-- header value — the Edge function's cron_auth handler will 401 cleanly.
-- ──────────────────────────────────────────────────────────
create or replace function public._cron_vault_read(secret_name text)
  returns text
  language sql
  security definer
  set search_path = public, vault
  stable
as $$
  select coalesce(
    (select decrypted_secret
       from vault.decrypted_secrets
      where name = secret_name
      limit 1),
    ''
  );
$$;
-- Lock the function down from every non-owner caller.
--
-- `revoke ... from public` only strips the PostgreSQL `public` pseudo-role's
-- default EXECUTE grant. On Supabase, `alter default privileges` *also*
-- grants EXECUTE on new `public.*` functions to the `anon`, `authenticated`,
-- and `service_role` login roles — those grants survive a `from public`
-- revoke and would expose this SECURITY DEFINER vault reader through the
-- PostgREST RPC surface (`POST /rest/v1/rpc/_cron_vault_read`). Revoking
-- from each named role closes that exfiltration path.
--
-- The function's owner (postgres, which is what pg_cron runs jobs as)
-- keeps its implicit owner privilege, so the schedules below still work.
revoke all on function public._cron_vault_read(text) from public;
revoke all on function public._cron_vault_read(text) from anon;
revoke all on function public._cron_vault_read(text) from authenticated;
revoke all on function public._cron_vault_read(text) from service_role;

-- ──────────────────────────────────────────────────────────
-- Sanity-check Vault entries exist. Emits a WARNING — does not fail the
-- migration, because the operator may apply schema first and wire secrets
-- moments later.
-- ──────────────────────────────────────────────────────────
do $checkvault$
declare
  v_secret text := public._cron_vault_read('internal_cron_secret');
  v_base   text := public._cron_vault_read('edge_base_url');
begin
  if length(trim(v_secret)) = 0 then
    raise warning
      'Vault secret ''internal_cron_secret'' is unset — Edge crons will send empty Bearer and get 401 until you run: insert into vault.secrets (name, secret) values (''internal_cron_secret'', ''<secret>'') on conflict (name) do update set secret = excluded.secret;';
  end if;
  if length(trim(v_base)) = 0 then
    raise warning
      'Vault secret ''edge_base_url'' is unset — Edge crons will POST to an empty URL until you run: insert into vault.secrets (name, secret) values (''edge_base_url'', ''https://<project-ref>.supabase.co'') on conflict (name) do update set secret = excluded.secret;';
  end if;
end
$checkvault$;

-- ──────────────────────────────────────────────────────────
-- 1. sms-inbound-worker — every minute
-- ──────────────────────────────────────────────────────────
select cron.schedule(
  'edge-sms-inbound-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/sms-inbound-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- ──────────────────────────────────────────────────────────
-- 2. voice-settlement-sweep — every 5 minutes
-- ──────────────────────────────────────────────────────────
select cron.schedule(
  'edge-voice-settlement-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/voice-settlement-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- ──────────────────────────────────────────────────────────
-- 3. voice-low-balance-alerts — hourly at :05
-- The :05 offset keeps it off the top-of-hour traffic spike shared with
-- customers' own scheduled workflows.
-- ──────────────────────────────────────────────────────────
select cron.schedule(
  'edge-voice-low-balance-alerts',
  '5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/voice-low-balance-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
