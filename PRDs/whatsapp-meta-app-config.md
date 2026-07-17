# WhatsApp channel — Meta app configuration checklist (browser, after merge)

Saved per Brian's request (Jul 16, 2026). These are the manual Meta app
dashboard steps that unlock the WhatsApp channel shipped in
`feat/whatsapp-channel`.

## App dashboard steps (developers.facebook.com → New Coworker app)

1. **Add the WhatsApp product** to the existing New Coworker Meta app.
2. **Create the Embedded Signup configuration** (Facebook Login for
   Business → Configurations → Create → WhatsApp Embedded Signup). Copy the
   resulting `config_id` into the Vercel env as `META_WHATSAPP_CONFIG_ID`
   (and `.env` locally). The integration card hides "Connect WhatsApp"
   until this is set.
3. **Subscribe the webhook**: Webhooks panel → object **WhatsApp Business
   Account** → callback `https://www.newcoworker.com/api/webhooks/meta`,
   verify token = `META_WEBHOOK_VERIFY_TOKEN` (same values as the Page /
   Instagram objects) → subscribe the **`messages`** field at v25.0.
4. **Pilot with the test number**: WhatsApp → API Setup provides a free
   Meta test number + temporary token usable in dev mode — message a
   personal WhatsApp from it to smoke the inbound webhook → engine →
   Cloud API reply loop end to end (KYP as the pilot tester).

## Review / availability chain

- `whatsapp_business_messaging` + `whatsapp_business_management` join the
  SAME pending App Review submission as the Messenger/lead permissions.
  They work in dev mode for app role-holders/testers today.
- Real-tenant **Embedded Signup unlocks when Tech Provider (Access)
  Verification clears** — the form submitted Jul 16 (SaaS Platform,
  newcoworker.com). Until then, only tester accounts can complete signup.
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
