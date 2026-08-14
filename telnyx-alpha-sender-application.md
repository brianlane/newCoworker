# Telnyx alphanumeric sender registration request

Send to: alpha_sender_id@telnyx.com (attach a copy of the business
registration document). Reference ticket #557577, where your team advised
alpha sender as the supported path for our international traffic.

---

Subject: Alphanumeric Sender ID registration: NEWCOWORKER (first destination Hong Kong)

Hi,

Following the guidance in ticket #557577 ("US long codes are for domestic
traffic only... use alpha sender"), we would like to register an
alphanumeric sender ID for one-way international notifications.

Requested sender ID: NEWCOWORKER
Company: [legal entity name]
Website: https://www.newcoworker.com
Business registration: attached
Relationship to the sender ID: NEWCOWORKER is our product and trade name
(newcoworker.com); messages notify our own subscribed business customers.

Use case: transactional, one-way account notifications to the OWNERS of
businesses subscribed to our platform (missed-call notices, booking
alerts, account notices). Low volume (tens of messages per month
initially). Recipients have a direct account relationship with New
Coworker and have opted into SMS notifications, with opt-out honored via
account settings. No marketing content, no customer-facing traffic.

Destinations: Hong Kong (+852) first, where we understand sender ID
pre-registration is required. We would also like the sender usable for
other alpha-supported destinations (e.g. UK, Germany, Singapore) as our
customers relocate; please advise which destinations need separate
registration.

Three questions before we complete setup, so we configure this correctly:

1. Fees: are there any one-time or recurring charges for alpha sender
   registration or usage, per sender or per destination country? Please
   state them explicitly.
2. Configuration: we plan to set the alpha sender on a dedicated
   messaging profile used only for these notifications; please confirm
   that is the intended setup, and whether the sender must also be
   registered per destination beyond Hong Kong.
3. Lead time: expected timeline for Hong Kong registration approval.

Thank you!

---

## Internal notes (not part of the email)

- Design constraints from the RCS record (Jul 18 2026 decision, PRD
  tier-economics-jul-2026.md): shared branded senders carry PLATFORM
  traffic only; customer-facing branded identity is a per-tenant
  Enterprise line item; verify all fees before building; no-reply must be
  explicit in message copy; smoke tests must assert the branded route was
  actually taken.
- Code follows only after registration approval AND fee confirmation:
  dedicated "International Alerts" messaging profile carrying the alpha
  sender; operational-alert senders target it for non-NANP destinations;
  alert copy appends the reply-redirect line; owner-reply relay never
  engages for alpha-sent messages; units metered with destination
  multipliers as usual.
