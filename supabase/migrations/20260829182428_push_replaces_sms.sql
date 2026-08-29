-- Let a reachable push device stand in for the alert TEXT, the same shape as
-- whatsapp_replaces_sms (20260822125053).
--
-- The motive is money and duplication: SMS is the only urgent channel we pay
-- for per message, and an owner with push on already gets the alert on the
-- same handset, seconds earlier, for nothing.
--
-- DEFAULT FALSE, unlike every other push preference, and that is the whole
-- safety story. Turning this on trades a metered channel that always arrives
-- for one that can die silently: an uninstalled app, a revoked permission, a
-- subscription the push service dropped. Nobody should be opted into that by
-- a migration. The delivery-time gate is pushDeliverable (a live subscription
-- exists), never pushConnected (which fails toward TRUE and would suppress
-- the text on a read blip), so a push channel that cannot deliver leaves the
-- SMS alone.
--
-- Push earns this in a way WhatsApp cannot, though, and that is why it is
-- worth offering: a notificationclick is a real read receipt, so
-- channel-liveness can tell whether the substituted channel is actually being
-- read rather than merely accepted. Suppressing a paid channel is only safe
-- when you can see the replacement working.

alter table public.notification_preferences
  add column if not exists push_replaces_sms boolean not null default false;

comment on column public.notification_preferences.push_replaces_sms is
  'Deliver urgent owner alerts by Web Push INSTEAD of SMS when a live push subscription exists. Default false: this suppresses a metered channel that always arrives in favour of one that can die quietly, so it is opt-in. Gated at delivery on a live subscription, never on the softer never-connected check, and never applied to a team broadcast (push reaches only devices that installed the app, while the text reaches the whole tagged roster) or to an alert redirected to one teammate.';

-- grants: none (push_replaces_sms): adds a column to notification_preferences,
-- which already grants service_role. No new object is created here.
