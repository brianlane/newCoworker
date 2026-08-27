-- The concrete end of a monthly subscription's intro-priced first cycle,
-- stamped by the ONE lever that breaks the derived first-cycle signal: the
-- admin billing-date comp. Moving the next charge re-anchors
-- stripe_current_period_start, after which isFirstBillingCycle() reads a
-- comped first-cycle tenant as renewed and the intro nudge silently never
-- sends (audit M3). The comp EXTENDS the first cycle, so the intro truly
-- ends at the new period end; this column records that boundary so the
-- nudge gate can accept either signal. Null for every uncomped row (the
-- derived signal keeps working there).
--
-- -- grants: none (monthly_intro_ends_at): adds a column to an existing
-- table; subscriptions' existing service_role grants cover it.
alter table public.subscriptions
  add column if not exists monthly_intro_ends_at timestamptz;
