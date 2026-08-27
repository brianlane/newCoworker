---
name: whatsapp-delivery-truth
description: "WhatsApp sends: ok means ACCEPTED not delivered; receipts now captured; KYP blocked by billing error 131042, not verification"
metadata: 
  node_type: memory
  type: project
  originSessionId: a49664f2-cac1-490d-8789-0c2dfb9867db
  modified: 2026-08-25T16:00:23.244Z
---

`deliverWhatsApp` returning `ok: true` means Meta **accepted** the message.
It says nothing about delivery. Until 2026-08-25 the sent/delivered/read/
**failed** webhooks were discarded (`value.statuses[]` "intentionally
ignored") and the outbound send never stored its wamid, so an accepted-then-
dropped message was permanently indistinguishable from a delivered one.

Fixed in PR #1609 (merged 2026-08-25): `messenger_messages` carries
`delivery_status` / `delivery_error_code` / `delivery_error_title` /
`delivery_updated_at`, the send stores the wamid, the webhook parses
`statuses[]`, and a `failed` receipt raises an owner-visible system log
(`event: whatsapp_message_failed`). Read it with
`npx tsx debug/whatsapp-delivery-report.ts`. Receipts land in ~15 seconds.

Two traps in that code, both live: Meta sends unix **seconds** (a bare
`Number()` dates every receipt to 1970), and the rank guard MUST live in the
UPDATE's WHERE clause, not between a read and a write, or concurrent
receipts bury a `failed` (Bugbot caught this).

**KYP Ads (056034a7) cannot start WhatsApp conversations: Meta error
131042, "Business eligibility payment issue".** That is BILLING, no working
payment method on the WABA. Fix is Business Manager > Billing and payments.

The diagnosis before receipts existed was WRONG and had already been sent to
the customer: KYP's WABA also has `business_verification_status: rejected`
and `name_status: NON_EXISTS`, both genuinely differing from a working
sandbox, and both red herrings for this symptom. A controlled differential
gave correlation; only the error code gave cause. See
[[feedback-verify-the-column-is-written]] and [[ok-true-is-not-a-commit]].

Why the shape fits: business-initiated (template) conversations are BILLED,
so all of them fail; customer-initiated replies inside the 24h window are
not, which is why KYP's real threads work. Across their whole history they
have **zero** business-initiated conversations, and nobody noticed because
nothing recorded the failures.

Related, and NOT fixed by any of the above:
- KYP's WABA sender number IS `+852 6010 0607`, James's own phone. A number
  on the Cloud API is taken off consumer WhatsApp, so **James cannot receive
  WhatsApp there at all**; messages to it arrive at our webhook. Alerts on
  WhatsApp would need the business account moved to a different number.
- Owner alerts already target his Canadian `+15145188192`
  (`notification_preferences.phone_number`), which works.
- `team_broadcast` dispatches skip the WhatsApp channel entirely by design
  (single-recipient leg, would reach an arbitrary subset), so WhatsApp can
  never carry an unowned-lead escalation. See
  [[unowned-lead-alerts-tagged-team]].
- Reading `primary_funding_id` on a WABA is refused unless the owning app's
  business is a WhatsApp BSP, so billing state is not inspectable from here.
  The error code is the evidence.

**Update 2026-08-26.** Confirmed from the receipts: every owner-alert
template send to James's Canadian mobile is stamped `failed` / `131042`, so
he receives NO WhatsApp alerts. He has never sent an INBOUND WhatsApp
message (`last_user_message_at` on that conversation is still epoch zero),
so the row is outbound-only.

The one WhatsApp path that works for KYP today is **James messaging the
business number first**: that opens the 24-hour window, and free-form
replies inside it are not billed as business-initiated, so 131042 cannot
block them. PR #1632 makes that reach his OWNER coworker; before it, an
inbound message always ran the CUSTOMER engine, which would have pitched him
and filed him as a lead. See [[owner-surface-registry]].

