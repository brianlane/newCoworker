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
-- (Azure AD) object id, and the Bot Connector's members endpoint turns that
-- into a UPN or email address, so resolveSurfaceSpeaker can answer owner /
-- teammate / customer the way it already does for Slack. The link-code path
-- stays available for a tenant whose directory does not expose an address,
-- but it is the exception here rather than the only way in.
--
-- ONE APP, MANY TENANTS, WITH A REAL BOUNDARY. Our Azure bot registration is
-- multi-tenant, so any Entra tenant that can find it could install it. The
-- boundary is `coworker_connections.external_workspace_id`, which holds the
-- activity's `channelData.tenant.id` and is unique per channel: an activity
-- from an unbound tenant belongs to nobody and is dropped. That is the same
-- shape as Slack's team_id and Telegram's bot id.

-- ---------------------------------------------------------------------
-- How a binding was established, third value.
--
-- `linked_via` is an audit column: it records HOW somebody came to hold
-- staff powers on a channel, and the two existing values are both acts by
-- the person (Telegram's shared contact card, or a redeemed code). Teams
-- introduces a third that is nobody's act: the tenant's own directory
-- answered, and we recorded what it said so a momentary Microsoft outage
-- does not tell an owner mid-conversation that we no longer know who they
-- are. Filing that under 'shared_contact' would make the audit column lie
-- about the strength of the evidence behind an access grant.
--
-- Recording it grants nothing on its own. The address is re-resolved
-- through the live roster on every turn, so somebody removed from the team
-- stops being staff on their next message, binding or no binding.
-- ---------------------------------------------------------------------
alter table public.coworker_channel_identities
  drop constraint if exists coworker_channel_identities_linked_via_check;
alter table public.coworker_channel_identities
  add constraint coworker_channel_identities_linked_via_check
  check (linked_via in ('shared_contact', 'link_code', 'directory'));

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
