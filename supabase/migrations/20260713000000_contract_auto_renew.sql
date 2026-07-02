-- Auto-renew opt-in for 12/24-month contracts (Hostinger-consistent model).
--
-- OFF (default): the commitment schedule created by ensureCommitmentSchedule
-- flips the subscription to the monthly renewal price at term end, so service
-- rolls month-to-month at the higher rate.
-- ON: the schedule is released, so the Stripe subscription naturally renews
-- for another full term at the (promotional) contract price, charged upfront.
--
-- Toggled by POST /api/billing/auto-renew, which flips this flag and
-- creates/releases the Stripe schedule atomically with it.
alter table public.subscriptions
  add column if not exists contract_auto_renew boolean not null default false;

comment on column public.subscriptions.contract_auto_renew is
  'Term contracts only. false = roll to month-to-month at the renewal price at term end (commitment schedule in place); true = Stripe subscription renews for another full term at the contract price (schedule released).';
