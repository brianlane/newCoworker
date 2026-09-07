-- Cold outreach can leave from a verified send-as alias of the connected mailbox.
--
-- Prospecting sends through the owner's connected Gmail or Outlook mailbox, and
-- the raw-MIME encoder (encodeRfc2822 in src/lib/email/owner-mailbox.ts) never
-- set a From header, so the provider stamped whatever it defaults to: the
-- OAuth account's primary address, or the mailbox's own default alias. A tenant
-- whose Gmail signs in as one account but corresponds from a verified alias on
-- their own domain (HQ: the Gmail is a personal Google account, the alias is
-- team@ on the product domain) had no way to say which address a cold email
-- should carry.
--
-- One knob, read by the outreach send path only:
--
--   outreach_settings.send_as_email   null (the default) keeps today's behavior
--     and lets the provider pick. An address puts it in the From and Reply-To
--     headers of every Gmail raw send, and in message.from / message.replyTo of
--     every Graph sendMail, for outreach pitches and follow-up nudges. The
--     address has to be one the mailbox is already allowed to send as (Gmail
--     "Send mail as", verified; Exchange "Send As" permission), because the
--     provider rewrites or refuses a From it does not recognise. Nothing here
--     verifies that: the setting is honoured, and a wrong address fails at the
--     provider with the reason in the ledger.
--
-- Replies still land in the connected mailbox because the alias is routed
-- there (HQ: Cloudflare routes the whole domain into that Gmail), which is what
-- keeps owned-thread reply detection working. Stored lowercased and trimmed by
-- the save path; the check below only refuses something that is not shaped
-- like one address, so a typo cannot be stored as a list or a display name.
alter table public.outreach_settings
  add column if not exists send_as_email text;

alter table public.outreach_settings
  drop constraint if exists outreach_settings_send_as_email_shape;
alter table public.outreach_settings
  add constraint outreach_settings_send_as_email_shape
  check (
    send_as_email is null
    or send_as_email ~ '^[^[:space:]@<>,;"]+@[^[:space:]@<>,;"]+\.[^[:space:]@<>,;"]+$'
  );

comment on column public.outreach_settings.send_as_email is
  'Verified send-as alias cold outreach leaves from (From and Reply-To). Null lets the provider pick, which is the connected account or its default alias.';

-- grants: none (outreach_settings): existing table, already granted; this adds
-- a column and a check, not objects.
