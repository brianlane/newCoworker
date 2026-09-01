---
name: email-delivery-truth
description: "Email sends: an id back means ACCEPTED, not delivered; receipts captured since #1628; provider_message_id is NOT unique; slack_assistant was silently rejected by the source check"
metadata:
  type: project
---

`sendOwnerEmail` returning an id means Resend **accepted** the message. It
says nothing about delivery. Until 2026-08-26 nothing consumed Resend's
delivery webhooks and most callers discarded the id, so a bounced email and a
delivered one were byte-identical in our data. Exactly the WhatsApp gap in
[[whatsapp-delivery-truth]], found the same way.

Worst for **alerts**, which had NO `email_log` row at all. The `notifications`
table records that we DECIDED to alert and that the send call returned;
neither is a claim anything arrived.

Fixed in PR #1628: `email_log` carries `delivery_status` /
`delivery_error_code` / `delivery_error_message` / `delivery_updated_at`,
alerts get a row (`source: 'notification'`, excluded from the dashboard Emails
page), `POST /api/webhooks/resend` verifies the Svix signature and applies the
receipt, and a failure raises `system_logs` (`source: email`, event
`email_delivery_failed`). Read it with
`npx tsx debug/email-delivery-report.ts`.

A bounced **outreach pitch** is a second gap on the same receipts. The
prospect ledger stayed at `sent`, which is exactly what the day-5 nudge
selects, so a hard bounce (ASAP Plumbing, 2026-08-31) was queued to be
re-mailed. The Aug 28 one-shot
(`scripts/oneshot/retire-bounced-outreach-prospects.ts`) repaired rows after
the fact. The live path is `retireProspectsOnBounce` in
`src/lib/outreach/bounce.ts`, called from the Resend webhook: `sent` ->
`failed` with `sent_at` kept, bounced/failed only (a complaint received the
mail), skip a row that already replied or already got its nudge. The one-shot
stays as backfill for receipts that landed before that shipped.

**`provider_message_id` is NOT unique.** A live scan on 2026-08-26 found 7
duplicated ids in a 1000-row sample, all Gmail-style hex ids from the
owner-mailbox paths. A unique index would fail to apply, and `maybeSingle()`
THROWS on the second row. The lookup takes the newest `direction = outbound`
match instead. Its index is on `provider_message_id` ALONE: a receipt arrives
with no tenant, and discovering the tenant is the point of the query.

Two more traps, both live:
- A failure that matches no row still logs, as
  `email_delivery_failed_unattributed` with a null business_id. Lots of Resend
  traffic writes no email_log row (verification, password set, provisioning),
  and an instant rejection can beat our own insert on the alert path. A third
  source, found 2026-08-28: HQ's Gmail sends deliver through Resend SMTP under
  an id we never log, see [[hq-gmail-sendas-resend-relay]].
- `RESEND_WEBHOOK_SECRET` must be set or the receiver refuses EVERY delivery.
  Unconfigured must not mean "trust anyone": a forged receipt could mark a
  delivered alert as bounced.

**Separate live bug repaired in the same migration:** `slack_assistant` was a
valid `EmailLogSource` in TypeScript and `src/lib/slack/worker.ts` inserted
it, but it was never added to the `email_log` source check constraint, so
every email the coworker sent from Slack was rejected and lost.
`recordOutboundAssistantEmail` swallows its insert error by design, so nothing
ever reported it. See [[verify-the-column-is-written]].
