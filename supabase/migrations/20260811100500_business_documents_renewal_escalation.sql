-- ---------------------------------------------------------------------------
-- Renewal escalation ladder + customer outreach stamps.
--
-- 20260811065500 added renewal_date with a single armed/cleared reminder
-- stamp (renewal_due_notified_at, the ~30-day heads-up). This adds the rest
-- of the ladder, one stamp per escalation tier, plus the outreach marker:
--
--   renewal_final_notified_at   - the ~7-day "final reminder".
--   renewal_overdue_notified_at - the day-after "renewal date passed".
--   renewal_outreach_enqueued_at - when the renewal fired its ONE
--                                  `document_renewal` webhook flow event
--                                  (customer outreach rides an owner-enabled
--                                  AiFlow; the stamp is per renewal date).
--
-- All stamps are reset whenever renewal_date changes (dashboard PATCH and
-- CSV import), re-arming the whole ladder for the next cycle.
-- ---------------------------------------------------------------------------

alter table public.business_documents
  add column if not exists renewal_final_notified_at timestamptz,
  add column if not exists renewal_overdue_notified_at timestamptz,
  add column if not exists renewal_outreach_enqueued_at timestamptz;

comment on column public.business_documents.renewal_final_notified_at is
  'One-reminder-per-state stamp for the ~7-day final renewal reminder. Reset when renewal_date changes.';
comment on column public.business_documents.renewal_overdue_notified_at is
  'One-reminder-per-state stamp for the past-due renewal notice. Reset when renewal_date changes.';
comment on column public.business_documents.renewal_outreach_enqueued_at is
  'When this renewal enqueued its document_renewal webhook flow event (customer outreach). One event per renewal date; reset when renewal_date changes.';
