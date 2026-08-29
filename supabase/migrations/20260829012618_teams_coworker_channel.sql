-- Microsoft Teams as an owner channel: alerts land there, and the owner or a
-- teammate can message the coworker back and get a real turn.
--
-- Almost everything this needs already exists. The transport is the shared
-- coworker_* pipeline (20260828223831), the identity table and enrolment
-- codes came with Telegram (20260828232002), and the plan gate and the
-- worker are channel-agnostic. What is left is the delivery channel, the
-- preference toggle, and one email-log source.
--
-- TEAMS NEEDS NO BINDING TABLE OF ITS OWN, which is the interesting
-- difference from Telegram. An inbound Teams activity carries an Entra
-- (Azure AD) identity, and TeamsInfo resolves it to a UPN or email address,
-- so resolveSurfaceSpeaker can answer owner / teammate / customer the way it
-- already does for Slack. The link-code path stays available for a tenant
-- whose directory does not expose an address, but it is the exception here
-- rather than the only way in.
--
-- ONE APP, MANY TENANTS, WITH A REAL BOUNDARY. Our Azure bot registration is
-- multi-tenant, so any Entra tenant that can find it could install it. The
-- boundary is `coworker_connections.external_workspace_id`, which holds the
-- activity's `channelData.tenant.id` and is unique per channel: an activity
-- from an unbound tenant belongs to nobody and is dropped. That is the same
-- shape as Slack's team_id and Telegram's bot id.

alter table public.notifications drop constraint if exists notifications_delivery_channel_check;
alter table public.notifications add constraint notifications_delivery_channel_check
  check (
    delivery_channel in ('sms', 'email', 'dashboard', 'whatsapp', 'slack', 'telegram', 'teams')
  );

alter table public.notification_preferences
  add column if not exists teams_urgent boolean not null default true;

comment on column public.notification_preferences.teams_urgent is
  'Send urgent owner alerts to the business''s connected Microsoft Teams conversation. Default true; only ever consulted for a business that HAS a connection, so a tenant without one records no teams rows at all.';

-- ---------------------------------------------------------------------
-- The coworker can send email from Teams, so the email log has to be able
-- to say so.
--
-- Not bookkeeping: `email_log.source` carries a CHECK, and `email_log` is a
-- RESIDENCY MOVED table whose constraint is mirrored into
-- vps/data-api/schema.sql. A value the app can produce but the box rejects
-- does not lose one row, it stops that tenant's write journal and queues
-- every later write behind it. Both sides move together or neither does.
-- ---------------------------------------------------------------------
alter table public.email_log drop constraint if exists email_log_source_check;
alter table public.email_log add constraint email_log_source_check
  check (
    source in (
      'ai_flow',
      'owner_mailbox',
      'email_trigger',
      'dashboard_chat',
      'sms_assistant',
      'voice_assistant',
      'slack_assistant',
      'telegram_assistant',
      'teams_assistant',
      'tenant_mailbox_inbound',
      'tenant_mailbox_outbound',
      'owner_manual',
      'email_coworker',
      'booking_reminder',
      'notification'
    )
  );

-- grants: none (teams delivery channel): every statement here alters an
-- existing table, whose grants are already in place. Teams introduces no
-- new objects; it reuses the coworker_* pipeline and the identity tables.
