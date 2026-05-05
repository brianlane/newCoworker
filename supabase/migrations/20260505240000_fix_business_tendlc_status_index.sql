-- Fix the per-business 10DLC retry index introduced in
-- 20260505210000_business_tendlc_status.sql.
--
-- Bugbot caught: the original partial index was
--   (telnyx_messaging_campaign_status, updated_at)
-- but the retry-worker query in `listBusinessesPendingTendlcAttach`
-- filters AND orders on `telnyx_messaging_campaign_last_attempt_at`:
--
--   .or('last_attempt_at.is.null, last_attempt_at.lt.<cutoff>')
--   .order('last_attempt_at', { ascending: true, nullsFirst: true })
--
-- The planner can't use an index whose second column is a different
-- timestamp than the one the query sorts on, so every cron tick was
-- doing a full table scan over `business_telnyx_settings`. At our
-- current scale that's nothing, but as we grow toward thousands of
-- businesses (and the cron runs every 5 minutes), the cost compounds.
--
-- Drop and recreate with the correct second column. `nulls first` ensures
-- the partial index satisfies the `last_attempt_at.is.null` predicate
-- branch as well — never-attempted rows are processed before any rows
-- whose stale timestamp passed the cutoff.

drop index if exists idx_business_telnyx_settings_campaign_pending;

create index if not exists idx_business_telnyx_settings_campaign_retry
  on business_telnyx_settings (
    telnyx_messaging_campaign_status,
    telnyx_messaging_campaign_last_attempt_at nulls first
  )
  where telnyx_messaging_campaign_status in ('pending', 'rejected');

comment on index idx_business_telnyx_settings_campaign_retry is
  'Drives the tendlc-attach-retry cron worker (`listBusinessesPendingTendlcAttach`). '
  'Partial index: only pending/rejected rows. Sorted by last_attempt_at NULLS FIRST '
  'so never-attempted DIDs are picked up before stale-retry candidates.';
