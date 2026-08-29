-- Let a reachable push device stand in for the alert TEXT, the same shape as
-- whatsapp_replaces_sms (20260822125053).
--
-- The motive is money and duplication: SMS is the only urgent channel we pay
-- for per message, and an owner with push on already gets the alert on the
-- same handset, seconds earlier, for nothing.
--
-- NULLABLE, WITH NO DEFAULT, and the three states are the point:
--
--   NULL   nobody has decided. The channel-liveness sweep may turn it on for
--          this tenant once it can SEE that push is read and the text is not.
--   true   substitute. Either the owner asked, or the sweep measured it.
--   false  never substitute. The owner said so, and no sweep may undo that.
--
-- A plain `default false` cannot express the difference between "never
-- decided" and "decided against", so an automatic enable would keep
-- overturning owners who had deliberately turned it off. A `default true`
-- would be worse: it would silence a paid channel that always arrives in
-- favour of one that can die quietly (an uninstalled app, a revoked
-- permission, a dropped subscription) for every tenant at once, on no
-- evidence at all.
--
-- The evidence is what makes the automatic case defensible, and push is the
-- first channel that can produce it. A notificationclick is a real read
-- receipt, so the sweep waits for push to be judged `live` (taps, not merely
-- a subscription) AND for SMS to be judged `silent` (alerts landed, nobody
-- answered). It deliberately does NOT act on an `unused` SMS verdict: that
-- means too few alerts to judge, which is absence of evidence, not evidence
-- of absence.
--
-- Delivery is additionally gated on pushDeliverable (a live subscription
-- exists) and never on the softer never-connected check, so a push channel
-- that cannot deliver right now always leaves the text alone.

alter table public.notification_preferences
  add column if not exists push_replaces_sms boolean;

comment on column public.notification_preferences.push_replaces_sms is
  'Deliver urgent owner alerts by Web Push INSTEAD of SMS. NULL = undecided (the channel-liveness sweep may enable it once push reads as live and SMS as silent); true = substitute; false = never, set by the owner and never overturned by the sweep. Gated at delivery on a live subscription, and never applied to a team broadcast (push reaches only devices that installed the app, while the text reaches the whole tagged roster) or to an alert redirected to one teammate.';

-- grants: none (push_replaces_sms): adds a column to notification_preferences,
-- which already grants service_role. No new object is created here.
