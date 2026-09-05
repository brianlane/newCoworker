---
name: contact-email-bounce-alert
description: "A bounced email the coworker sent to a CONTACT is the tenant's to act on, not HQ's: the Resend webhook pages the owner (kind contact_email_bounce) and logs warn; owner alerts, outreach, unattributed stay error"
metadata:
  type: project
---

Found 2026-09-04 from KYP's one `email_delivery_failed` on the System Errors
card (system_logs 126770, email_log 892cef9e): a Vantage Flow Media lead
booked on Calendly with a work address whose mailbox did not exist. Our
booking-confirmation email hard-bounced at Google; Calendly's own invite went
to the same dead address; the lead had our confirmation text and nothing
else. His working +1 mobile and his lead-form email (a different, personal
address) were on the contact record the whole time. Nobody at the tenant was
told, because the bounce went only to the admin feed.

**The rule** (the same one as [[page-only-on-what-is-actionable]]): decide by
`email_log.source` WHO a delivery failure is for, then page them and only
them.

- Customer-facing sources (`ai_flow`, `tenant_mailbox_outbound`, the
  `*_assistant` surfaces, `email_coworker`, `booking_reminder`,
  `owner_manual`): the tenant's. `notifyContactEmailBounce`
  (src/lib/notifications/contact-email-bounce-notify.ts) pages the contact's
  owner with the phone and any DIFFERENT address on the record; the admin
  row is `warn` with "The account owner was alerted; nothing for HQ to do."
- `notification` (an alert TO the owner): the owner's channel is dying, HQ
  calls them; stays `error`, and is never echoed to the address that
  bounced.
- `owner_mailbox`: mixed, and where HQ's outreach pitches leave from; those
  are retired on bounce already, so no page. Stays `error`.
- Unattributed, or a page no channel accepted: `error`. The action is ours.

**Contact resolution is phone-first and the run context is the road that
worked.** By address, then by `email:<addr>` key, then the sending
`ai_flow_runs.context.vars.lead_phone` (then `trigger.phone_number` /
`trigger.from`). The motivating case matched NEITHER address lookup, because
the contact carried the form email and the booking used another; the run's
phone found the row and, with it, the alternate address. Expect this shape
on every tenant whose leads book on Calendly (4 of KYP's 37 August bookings
used a different address than their lead record).

**Category is `system`, not `leads`.** A muted "leads" category (KYP has it
off to cut chatter) must not hide "the coworker could not reach someone".

**Backfill:** `scripts/oneshot/alert-bounced-contact-email.ts` replays
pre-fix bounces through the same notifier, idempotent on
`notifications.payload->>email_log_id`. Central `email_log` for a `vps`
tenant is purged past the 72h keep floor, so it cannot see old bounces there.

Related: [[email-delivery-truth]], [[delivered-is-not-received]].
