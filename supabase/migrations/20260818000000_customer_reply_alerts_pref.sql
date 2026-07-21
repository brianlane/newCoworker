-- Customer reply alerts: opt-in owner notification when a client texts the
-- business (KYP feedback, Jul 20 2026). James missed Tim Tsai's replies
-- while working the thread live — "You need to let me know when clients
-- text back i didnt see his texts" — and the AI promised alerts no feature
-- backed. The sms-inbound-worker now pages the owner deterministically on
-- every customer inbound (per-contact coalescing, forward_owner contacts
-- skipped) when this toggle is on.
--
-- Default OFF by design (same posture as aiflow_failure_alerts): client
-- replies page the owner only after they explicitly opt in from the
-- notifications page.

alter table public.notification_preferences
  add column if not exists customer_reply_alerts boolean not null default false;

comment on column public.notification_preferences.customer_reply_alerts is
  'Opt-in (default false): notify the owner when a customer texts the business (per-contact coalescing; forward_owner contacts excluded).';
