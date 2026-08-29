-- Telegram as an owner channel: alerts land there, and the owner or a
-- teammate can message the coworker back and get a real turn.
--
-- The transport is already built (coworker_* pipeline, 20260828223831). What
-- this adds is the delivery channel, the preference toggle, and the one
-- genuinely new concept Telegram forces on us: an explicit identity binding.
--
-- WHY TELEGRAM NEEDS A BINDING TABLE AND THE OTHER CHANNELS DO NOT.
-- resolveSurfaceSpeaker answers "is this the owner, a teammate, or a
-- stranger" from a phone number or an email address. Slack supplies a
-- verified profile email, Google Chat a Workspace address, Teams an Entra
-- identity, and a WhatsApp psid IS a confirmed phone number. Telegram
-- supplies NEITHER: a `from.id` is an opaque integer, and a @username is
-- self-chosen and re-assignable. So a Telegram user id has to be bound to a
-- known person once, deliberately, and that binding is what this table is.
--
-- Two ways in, both of which end in a row here:
--   1. The person taps "share my phone number" (Telegram's request_contact
--      keyboard). Telegram verifies phone numbers at signup, so this yields
--      a real E.164 that the EXISTING resolver matches against the owner
--      numbers and the roster, exactly like WhatsApp.
--   2. They paste a short-lived signed link code minted in the dashboard by
--      a session that already holds manage_settings.
--
-- Anything unmatched stays a customer, which on this surface means silence.

-- ---------------------------------------------------------------------
-- Who a given channel account actually is.
-- ---------------------------------------------------------------------
create table if not exists public.coworker_channel_identities (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null,
  -- The provider's own account id. Opaque and stable; NOT a handle, which
  -- the account holder can change and someone else can then claim.
  external_user_id text not null,
  -- The roster row this account belongs to, when it is a teammate. Null for
  -- the owner, who is not a roster row.
  employee_id uuid references public.ai_flow_team_members(id) on delete cascade,
  is_owner boolean not null default false,
  -- What the platform actually learned, kept so a later reader can tell a
  -- verified phone from a hand-linked account without re-deriving it.
  verified_phone_e164 text,
  verified_email text,
  -- 'shared_contact' | 'link_code'. Recorded because they are not equally
  -- strong: a shared contact is the PROVIDER asserting a number it verified,
  -- a link code is us asserting that whoever held the code was the person
  -- who generated it.
  linked_via text not null check (linked_via in ('shared_contact', 'link_code')),
  linked_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One binding per (business, channel, account). Re-linking updates in place
-- rather than stacking rows, so there is never a question of which of two
-- bindings for the same account is the live one.
create unique index if not exists uq_coworker_channel_identities_account
  on public.coworker_channel_identities (business_id, channel, external_user_id);

-- The read path: resolve one inbound account.
create index if not exists idx_coworker_channel_identities_lookup
  on public.coworker_channel_identities (channel, external_user_id);

alter table public.coworker_channel_identities enable row level security;
grant select, insert, update, delete
  on table public.coworker_channel_identities to service_role;

-- ---------------------------------------------------------------------
-- Short-lived enrolment codes.
--
-- Minted in the dashboard, presented once in the channel. Stored rather
-- than signed-and-stateless so that redemption can be made SINGLE USE: a
-- signed code that is merely unexpired can be replayed by anyone who sees
-- it, and these travel through a chat window where a screenshot is normal.
-- ---------------------------------------------------------------------
create table if not exists public.coworker_channel_link_codes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null,
  -- sha256 of the code, never the code itself: a leaked database row must
  -- not be redeemable.
  code_hash text not null,
  -- Who this code will bind the presenting account TO. Null employee_id
  -- with is_owner true means "this enrols the owner".
  employee_id uuid references public.ai_flow_team_members(id) on delete cascade,
  is_owner boolean not null default false,
  created_by_user_id uuid,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_external_user_id text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_coworker_channel_link_codes_hash
  on public.coworker_channel_link_codes (code_hash);

-- The redemption read: an unexpired, unredeemed code for this channel.
create index if not exists idx_coworker_channel_link_codes_open
  on public.coworker_channel_link_codes (channel, expires_at)
  where redeemed_at is null;

alter table public.coworker_channel_link_codes enable row level security;
grant select, insert, update, delete
  on table public.coworker_channel_link_codes to service_role;

-- ---------------------------------------------------------------------
-- Telegram as a delivery channel.
--
-- Same shape as 20260822113305_slack_alert_channel.sql: widen the CHECK,
-- add the toggle, default ON so a tenant who connects it starts receiving
-- alerts without a second step.
--
-- NO telegram_digest column, deliberately, following whatsapp_urgent rather
-- than slack_urgent/slack_digest. The digest is a daily summary that suits a
-- feed you scroll; a Telegram message is a phone notification. If a digest
-- is wanted here later it is one column and one leg, and it should be asked
-- for rather than assumed.
-- ---------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_delivery_channel_check;
alter table public.notifications add constraint notifications_delivery_channel_check
  check (delivery_channel in ('sms', 'email', 'dashboard', 'whatsapp', 'slack', 'telegram'));

alter table public.notification_preferences
  add column if not exists telegram_urgent boolean not null default true;

comment on column public.notification_preferences.telegram_urgent is
  'Send urgent owner alerts to the business''s connected Telegram bot. Default true; only ever consulted for a business that HAS a connection, so a tenant without one records no telegram rows at all.';

-- ---------------------------------------------------------------------
-- The coworker can send email from Telegram, so the email log has to be
-- able to say so.
--
-- This is not bookkeeping. `email_log.source` carries a CHECK, and
-- `email_log` is a RESIDENCY MOVED table whose constraint is mirrored into
-- vps/data-api/schema.sql. A value the app can produce but the box rejects
-- does not just lose one row: the tenant's write journal replays in order,
-- so it STOPS there and queues every later write behind it. Both sides move
-- together or neither does.
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
      'tenant_mailbox_inbound',
      'tenant_mailbox_outbound',
      'owner_manual',
      'email_coworker',
      'booking_reminder',
      'notification'
    )
  );

-- grants: none (telegram delivery channel): the two statements above alter
-- existing tables, whose grants are already in place. The new tables at the
-- top of this file carry their own.
