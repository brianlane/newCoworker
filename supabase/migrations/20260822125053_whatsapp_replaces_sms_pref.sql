-- Owner alerts: "WhatsApp instead of SMS" preference.
--
-- Off by default: every enabled channel keeps firing independently, exactly
-- as today. When ON and the business has a connected WhatsApp integration
-- with the whatsapp_urgent toggle enabled, the urgent-alert SMS leg is
-- skipped (recorded as skipped: whatsapp_preferred) and the owner receives
-- the identical alert text on WhatsApp only. If WhatsApp is not connected
-- or its toggle is off, SMS proceeds unchanged, so flipping this can never
-- leave the owner without a phone channel.
--
-- Built for owners whose phones SMS cannot reach at all (non-NANP numbers:
-- Telnyx long codes cannot originate international SMS, ticket #557577) and
-- for anyone who simply prefers WhatsApp.
--
-- Column-only change on an existing table: notification_preferences already
-- carries its Data API grants.

alter table public.notification_preferences
  add column if not exists whatsapp_replaces_sms boolean not null default false;

comment on column public.notification_preferences.whatsapp_replaces_sms is
  'When true and WhatsApp is connected with whatsapp_urgent on, urgent-alert SMS to the owner is skipped (whatsapp_preferred) and the alert rides WhatsApp only. Default false: channels stay independent.';
