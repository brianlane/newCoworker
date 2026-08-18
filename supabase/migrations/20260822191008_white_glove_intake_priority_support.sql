-- A completed white-glove questionnaire opens the 30-day priority support
-- window, even when the prospect never buys a package.
--
-- The marketing and billing copy tells anyone filling in the questionnaire that
-- "either package opens a 30-day priority phone & video support line". In
-- practice not every prospect who completes the questionnaire pays, so the
-- window used to open only on a PAID package or offer and those tenants got
-- nothing. This closes that gap: completing the questionnaire is the trigger.
--
-- IDEMPOTENCE is the whole point of this column. The grant is claimed with a
-- compare-and-swap (UPDATE ... WHERE priority_support_granted_at IS NULL
-- ... RETURNING id), so re-running the signup attach, a Stripe-first onboarding
-- that re-attaches once the real email lands, or two concurrent callers can
-- only ever grant once per questionnaire. Nulling it again is what a failed
-- grant does, so a retry can still pick the row up.
alter table public.white_glove_intakes
  add column if not exists priority_support_granted_at timestamptz;

comment on column public.white_glove_intakes.priority_support_granted_at is
  'When this completed questionnaire opened a priority support window. NULL = not yet granted; the claim is a compare-and-swap on this column, so a grant can never run twice.';

-- Matches the attach path exactly: completed, not yet granted, keyed to the
-- business the questionnaire was linked to.
create index if not exists white_glove_intakes_priority_grant_idx
  on public.white_glove_intakes (business_id)
  where status = 'completed' and priority_support_granted_at is null;

-- grants: none (white_glove_intakes_priority_grant_idx): index only
