---
name: hq-gmail-sendas-resend-relay
description: "HQ Gmail's default send-as is team@newcoworker.com relayed via smtp.resend.com, so every owner-mailbox send delivers through Resend under an id email_log never captures; bounces surface as email_delivery_failed_unattributed"
metadata:
  type: project
---

Diagnosed 2026-08-28 from two `email_delivery_failed_unattributed` rows
(system_logs 113594 and 115983, both Prospecting pitches from HQ).

**The mechanism.** Brian's Gmail (`newcoworkerteam@gmail.com`, HQ's one
workspace connection, transport `direct`) has three send-as identities. The
DEFAULT is `team@newcoworker.com`, and both `team@` and `contact@` are
configured with an SMTP relay (`smtpMsa`): host `smtp.resend.com:465`. Our
raw-MIME encoder (`encodeRfc2822` in src/lib/email/owner-mailbox.ts) sets no
`From:` header, so Gmail stamps the default alias and hands the message to
OUR OWN Resend account for delivery. Confirmed by fetching the sent pitches:
`From: Brian <team@newcoworker.com>`.

Consequences, all verified live:

- The Gmail API returns a Gmail message id (16 hex chars) and that is what
  callers log to `email_log.provider_message_id`. Resend assigns the SAME
  message its own UUID that nothing on our side ever sees. A Resend delivery
  receipt for it can therefore NEVER match a row: failures land as
  `email_delivery_failed_unattributed` (null business_id), successes miss
  quietly. This applies to EVERY send through this connection: outreach
  pitches and nudges, email-coworker replies, the voice/dashboard email
  tools.
- `email_log.from_email` says `newcoworkerteam@gmail.com` for these sends
  because `connectionEmail` reads the CONNECTION's account, while the wire
  From is `team@newcoworker.com`: the same account-vs-alias gap as
  [[self-reply-loop-alias-trap]].
- Receipts exist only since the webhook went live (2026-08-26, PR #1628, see
  [[email-delivery-truth]]). Outreach bounces before that were dropped;
  history is only in the Resend dashboard. The production `RESEND_API_KEY`
  is a SEND-ONLY restricted key, so no script can read messages or events
  back; dashboard only.

**Why the first bounced pitch had a garbage recipient.** The outreach probe
(`extractEmails` in src/lib/outreach/probe.ts) harvested
`dd0a55ccb8124b9c9d938e3acf41f8aa@sentry.wixpress.com` from
`sunlandautomesa.com`, a Wix site. That is the public key of a Sentry DSN in
the page's JavaScript (`https://<32-hex>@sentry.wixpress.com/<id>`), which
an email regex reads as an address. `EMAIL_NOISE` blocks `sentry.io`,
`sentry-next`, and `wix.com` but NOT `wixpress.com`, and there is no guard
against a 32-hex machine localpart.

**How to apply:** treat unattributed Resend failures whose subject matches an
outreach pitch as REAL undelivered pitches (the ledger still says `sent`,
and the day-5 nudge will re-mail the same dead address). When auditing
deliverability, remember Gmail send-as smtpMsa means "delivered by Resend",
not "delivered by Google".

**Fixes shipped 2026-08-28:** the webhook now falls back to recipient +
subject over a bounded 4-day window for unmatched FAILURES
(`applyEmailDeliveryStatusByRecipient` in src/lib/email/delivery.ts), so
relay bounces surface attributed; the probe drops `wixpress.com`,
`@sentry.`, and 20+ hex-char localparts; and
`scripts/oneshot/retire-bounced-outreach-prospects.ts` (applied same day,
five prospects) retires bounced pitches out of the nudge queue, evidence
read from system_logs at run time.
