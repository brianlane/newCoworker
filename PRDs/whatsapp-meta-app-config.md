# WhatsApp channel — Meta app configuration checklist (browser, after merge)

Saved per Brian's request (Jul 16, 2026). These are the manual Meta app
dashboard steps that unlock the WhatsApp channel shipped in
`feat/whatsapp-channel`.

## App dashboard steps (developers.facebook.com → New Coworker app)

1. ~~**Add the WhatsApp product**~~ DONE — the "Connect with customers
   through WhatsApp" use case is on the app.
2. ~~**Create the Embedded Signup configuration**~~ DONE (Jul 16) —
   "NewCoworker WhatsApp Signup", `config_id 2170825997107136`, created
   from the official "WhatsApp Embedded Signup" template. Set as
   `META_WHATSAPP_CONFIG_ID` in `.env` and on Vercel (production +
   preview); production redeployed to pick it up.
   **Caveat:** the template locks token type to a system-user token with
   **60-day expiration** (the "Never" option is disabled by the template).
   Tenant connections will need a reconnect ~every 60 days unless we add a
   token-refresh job later.
3. ~~**Subscribe the webhook**~~ DONE (Jul 16) — WhatsApp Business Account
   object verified against `https://www.newcoworker.com/api/webhooks/meta`
   with the shared verify token; **`messages`** field subscribed at v25.0.
4. **Pilot with the test number** (REMAINING, needs a real phone):
   WhatsApp → API Setup provides a free Meta test number + temporary token
   usable in dev mode — message a personal WhatsApp from it to smoke the
   inbound webhook → engine → Cloud API reply loop end to end (KYP as the
   pilot tester).

## Review / availability chain

- **Tech Provider (Access) Verification: APPROVED Jul 16, 2026.**
- `whatsapp_business_messaging` + `whatsapp_business_management` show
  "Ready for testing" (0 outstanding requirements) but the App Review
  submission is still **Not submitted** — the whole request bundle
  (WhatsApp + Messenger/lead permissions) needs to be submitted for
  Advanced Access before arbitrary (non-role-holder) tenants can connect.
  They work today for app role-holders/testers.
- Template review: the two stock utility templates (`nc_owner_alert`,
  `nc_contact_followup`) are auto-registered per tenant WABA at connect
  and typically clear Meta review in minutes; out-of-window sends are
  skipped (with an honest note) until APPROVED.

## Tenant-facing constraints worth remembering

- A phone number already registered on the consumer WhatsApp app cannot be
  used — the tenant either deletes that registration or uses a different
  number.
- Service conversations (replies inside the 24h window) are free;
  business-initiated template messages are billed by Meta to the tenant's
  WABA payment method.
