-- Weekly digest: preference column + Monday pg_cron schedule.
--
-- The notifications-digest Edge function now accepts {"window":"weekly"} in
-- the cron POST body and aggregates 7 days of activity instead of 24 hours.
-- Gate is a separate toggle so owners can keep the daily digest and drop the
-- weekly one (or vice versa). Default on, matching every other notification
-- preference.

alter table notification_preferences
  add column if not exists email_digest_weekly boolean not null default true;

-- Cron design mirrors 20260509000001_schedule_notifications_digest_cron.sql:
-- secret + base URL come from Supabase Vault at execution time.
--
-- Schedule: Mondays at 14:05 UTC (≈ 7:05am PT, 10:05am ET) — an hour after
-- the daily digest so the two emails don't land at the same moment on Monday
-- mornings.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
declare
  job_name text;
begin
  foreach job_name in array array['edge-notifications-digest-weekly']
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
      'Vault secret ''internal_cron_secret'' is unset — weekly digest cron will 401 until you set it.';
  end if;
  if length(trim(v_base)) = 0 then
    raise warning
      'Vault secret ''edge_base_url'' is unset — weekly digest cron will POST to an empty URL until you set it.';
  end if;
end
$checkvault$;

select cron.schedule(
  'edge-notifications-digest-weekly',
  '5 14 * * 1',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/notifications-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{"window":"weekly"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
