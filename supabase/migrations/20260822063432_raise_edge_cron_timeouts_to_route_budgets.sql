-- Raise every edge cron job's HTTP timeout to cover its Next route's budget.
--
-- Same defect class as 20260822013908 (edge-vps-term-renewal-sweep): the
-- pg_cron job hangs up before the route it calls is allowed to finish, so
-- cron.job_run_details records a timeout on a run that actually succeeded.
-- A genuine timeout then looks identical to the noise.
--
-- tests/cron-timeout-parity.test.ts pins the contract for every pg_cron job
-- that forwards to a src/app/api/internal/<name>/route.ts. These 13 jobs were
-- the ones below their route's maxDuration * 1000. Each route declares
-- maxDuration = 300, so each job goes to 300000:
--
--   edge-analytics-snapshot-sweep      280000 -> 300000
--   edge-blog-publish-sweep            280000 -> 300000
--   edge-blog-weekly-digest            280000 -> 300000
--   edge-contract-term-nudge-sweep     280000 -> 300000
--   edge-data-retention-sweep          280000 -> 300000
--   edge-document-expiration-sweep     280000 -> 300000
--   edge-email-campaign-sweep          280000 -> 300000
--   edge-monthly-intro-nudge-sweep     280000 -> 300000
--   edge-outreach-sweep                280000 -> 300000
--   edge-platform-cost-sync            295000 -> 300000
--   edge-social-post-sweep             280000 -> 300000
--   edge-subscription-grace-sweep      120000 -> 300000
--   edge-vps-billing-posture            90000 -> 300000
--
-- Schedules and bodies are carried over verbatim from each job's last
-- definition; only timeout_milliseconds changes. The migrations those came
-- from are already applied, so they are left untouched and the jobs are
-- re-scheduled here instead.
--
-- Known follow-up, deliberately NOT in this migration: the Edge bridge each
-- job posts to caps its own forward request at REQUEST_TIMEOUT_MS, which is
-- 290_000 for most of these (120_000 for subscription-grace-sweep, 90_000 for
-- vps-billing-posture). Until those are raised to 300_000 the bridge, not
-- pg_cron, becomes the layer that gives up early. This migration removes
-- pg_cron as a source of false timeouts; it does not by itself let a full
-- 300s run complete.
--
-- grants: none (cron schedule only; creates no objects).

select cron.unschedule('edge-analytics-snapshot-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-analytics-snapshot-sweep'
);

select cron.schedule(
  'edge-analytics-snapshot-sweep',
  '50 2 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/analytics-snapshot-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-blog-publish-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-blog-publish-sweep'
);

select cron.schedule(
  'edge-blog-publish-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/blog-publish-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-blog-weekly-digest')
where exists (
  select 1 from cron.job where jobname = 'edge-blog-weekly-digest'
);

select cron.schedule(
  'edge-blog-weekly-digest',
  '0 15 * * 1',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/blog-weekly-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-contract-term-nudge-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-contract-term-nudge-sweep'
);

select cron.schedule(
  'edge-contract-term-nudge-sweep',
  '25 15 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/contract-term-nudge-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-data-retention-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-data-retention-sweep'
);

select cron.schedule(
  'edge-data-retention-sweep',
  '35 1 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/data-retention-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-document-expiration-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-document-expiration-sweep'
);

select cron.schedule(
  'edge-document-expiration-sweep',
  '5 2 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/document-expiration-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-email-campaign-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-email-campaign-sweep'
);

select cron.schedule(
  'edge-email-campaign-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/email-campaign-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-monthly-intro-nudge-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-monthly-intro-nudge-sweep'
);

select cron.schedule(
  'edge-monthly-intro-nudge-sweep',
  '15 15 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/monthly-intro-nudge-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-outreach-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-outreach-sweep'
);

select cron.schedule(
  'edge-outreach-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/outreach-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-platform-cost-sync')
where exists (
  select 1 from cron.job where jobname = 'edge-platform-cost-sync'
);

select cron.schedule(
  'edge-platform-cost-sync',
  '10 11 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/platform-cost-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- Telnyx MDR paging + sequential Hostinger calls can run several
    -- minutes. Was 295000 to match the Edge bridge's 290s ceiling; now
    -- 300000 so pg_cron outlasts the route's own maxDuration = 300.
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-social-post-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-social-post-sweep'
);

select cron.schedule(
  'edge-social-post-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/social-post-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-subscription-grace-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-subscription-grace-sweep'
);

select cron.schedule(
  'edge-subscription-grace-sweep',
  '15 0 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/subscription-grace-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

select cron.unschedule('edge-vps-billing-posture')
where exists (
  select 1 from cron.job where jobname = 'edge-vps-billing-posture'
);

select cron.schedule(
  'edge-vps-billing-posture',
  '0 13 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/vps-billing-posture',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
