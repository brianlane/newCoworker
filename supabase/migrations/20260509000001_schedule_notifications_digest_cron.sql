-- Schedule the daily notifications digest Edge function via pg_cron + pg_net.
--
-- Design mirrors `20260422000000_schedule_edge_crons.sql`: the bearer secret
-- and the edge base URL come from Supabase Vault at execution time so neither
-- value lands in git. See that migration's preamble for security/setup notes.
--
-- Schedule: daily at 13:05 UTC (≈ 6:05am PT, 9:05am ET). The :05 offset keeps
-- it off the top-of-hour traffic spike and after the hourly low-balance-alerts
-- job fires, so the digest sees a freshly settled view.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
declare
  job_name text;
begin
  foreach job_name in array array['edge-notifications-digest']
  loop
    perform cron.unschedule(job_name)
    where exists (select 1 from cron.job where jobname = job_name);
  end loop;
end
$unschedule$;

do $checkvault$
declare
  v_secret text := public._cron_vault_read('internal_cron_secret');
  v_base   text := public._cron_vault_read('edge_base_url');
begin
  if length(trim(v_secret)) = 0 then
    raise warning
      'Vault secret ''internal_cron_secret'' is unset — notifications-digest cron will 401 until you set it.';
  end if;
  if length(trim(v_base)) = 0 then
    raise warning
      'Vault secret ''edge_base_url'' is unset — notifications-digest cron will POST to an empty URL until you set it.';
  end if;
end
$checkvault$;

select cron.schedule(
  'edge-notifications-digest',
  '5 13 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/notifications-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
