-- Its own off-switch for the monthly growth recap email.
--
-- Shipped in the same PR that added the recap, because without it the only
-- way to stop the recap was the GLOBAL unsubscribe, which also clears
-- sms_urgent, whatsapp_urgent, email_urgent, email_digest,
-- email_digest_weekly, dashboard_alerts and sms_warm_transfer. An owner who
-- simply did not want a monthly summary would have pressed the footer link
-- and silently lost every urgent lead alert on every channel. A new
-- recurring email has to come with a proportionate way to decline it.
--
-- NOT folded into email_digest. That flag governs the daily/weekly activity
-- digest, a different product at a different cadence: the owner who finds a
-- daily digest too noisy is exactly the one a monthly summary suits, so
-- reusing the flag would take the recap away from the people most likely to
-- want it.
--
-- Defaults TRUE, matching every other channel toggle here: the recap is
-- useful and low-frequency, and an owner who disagrees has one switch.
--
-- grants: none (monthly_recap_preference): adds a column to
-- public.notification_preferences, which already carries its grants; no new
-- object is created.

alter table public.notification_preferences
  add column if not exists email_monthly_recap boolean not null default true;

comment on column public.notification_preferences.email_monthly_recap is
  'Send the monthly growth recap email (leads/texts/calls/minutes for the month that ended). Default true. Cleared by the global unsubscribe and by the recap-scoped unsubscribe link in the email footer; see src/lib/analytics/monthly-growth-sweep.ts.';
