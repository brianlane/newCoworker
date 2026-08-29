-- Google Chat as an owner channel: alerts land there, and the owner or a
-- teammate can message the coworker back and get a real turn.
--
-- The third channel on the shared coworker_* pipeline (20260828223831), and
-- the cheapest of the three, because by now almost nothing is new. The
-- transport, the identity table, the enrolment codes, the plan gate and the
-- worker are all channel-agnostic. What is left is the delivery channel, the
-- preference toggle, and one email-log source.
--
-- A CODE BINDS THE SPACE, which is the one genuinely different idea and the
-- reason there is no "paste your workspace id" step. Slack learns its
-- workspace from an OAuth install and Teams has the owner paste an Entra
-- tenant id, but a Google Chat app is simply ADDED to a space by whoever is
-- in it, and a space name is opaque and shown nowhere in the Chat UI, so
-- there is no value the owner could have typed in beforehand. The connect
-- code therefore does double duty: redeeming it says which business, which
-- binds the space, and says who they are, which binds them.
--
-- That makes `coworker_connections.external_workspace_id` the SPACE for this
-- channel, unique per channel as always, so a space belongs to exactly one
-- business and a second code cannot quietly move a bound one.

alter table public.notifications drop constraint if exists notifications_delivery_channel_check;
alter table public.notifications add constraint notifications_delivery_channel_check
  check (
    delivery_channel in (
      'sms', 'email', 'dashboard', 'whatsapp', 'slack', 'telegram', 'teams', 'google_chat'
    )
  );

alter table public.notification_preferences
  add column if not exists google_chat_urgent boolean not null default true;

comment on column public.notification_preferences.google_chat_urgent is
  'Send urgent owner alerts to the business''s connected Google Chat space. Default true; only ever consulted for a business that HAS a connection, so a tenant without one records no google_chat rows at all.';

-- ---------------------------------------------------------------------
-- The coworker can send email from Google Chat, so the email log has to be
-- able to say so.
--
-- Not bookkeeping: `email_log.source` carries a CHECK, and `email_log` is a
-- RESIDENCY MOVED table whose constraint is mirrored into
-- vps/data-api/schema.sql. A value the app can produce but the box rejects
-- does not lose one row, it stops that tenant's write journal and queues
-- every later write behind it. Both sides move together or neither does,
-- and the same is true of the delivery_channel constraint above.
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
      'google_chat_assistant',
      'tenant_mailbox_inbound',
      'tenant_mailbox_outbound',
      'owner_manual',
      'email_coworker',
      'booking_reminder',
      'notification'
    )
  );

-- grants: none (google chat delivery channel): every statement here alters
-- an existing table, whose grants are already in place. Google Chat
-- introduces no new objects; it reuses the coworker_* pipeline and the
-- identity tables.
