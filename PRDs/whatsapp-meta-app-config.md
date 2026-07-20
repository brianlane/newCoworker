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
4. ~~**Pilot with a real number**~~ DONE (Jul 20) — connected HQ's Telnyx
   number (+1 602-313-1823) through the in-app "Connect WhatsApp" Embedded
   Signup end to end, and confirmed inbound WhatsApp → engine → Cloud API
   reply. See the Cloud-API-registration note below — Embedded Signup alone
   left the number unusable until it was registered.
5. ~~**Register the number on the Cloud API at connect**~~ DONE in code
   (Jul 20, PR #787). Embedded Signup *verifies* a number but does not put
   it on the Cloud API — until `POST /{phone_number_id}/register` runs, the
   number stays `platform_type: NOT_APPLICABLE` and consumers see "invite on
   WhatsApp". The connect handler
   (`src/app/api/integrations/whatsapp/route.ts`) now registers the number
   itself, with a deterministic per-number PIN
   (`deriveWhatsAppRegistrationPin`, from `INTEGRATIONS_ENCRYPTION_KEY`) so
   reconnects re-register idempotently instead of hitting a two-step-PIN
   mismatch. Best-effort: a pre-existing-PIN number is logged, not fatal.

## Meta-hosted Embedded Signup landing page (fallback onboarding)

Generated Jul 20, 2026 (Onboarding tab → "Generate link"). An alternative
to the in-app "Connect WhatsApp" button — a URL a customer can open
directly to run Embedded Signup. We default to the in-app flow; this is a
fallback / share-link option.

```
https://business.facebook.com/messaging/whatsapp/onboard/?app_id=1554839372962421&config_id=2170825997107136&extras=%7B%22version%22%3A%22v4%22%2C%22sessionInfoVersion%22%3A%223%22%2C%22featureType%22%3A%22whatsapp_business_app_onboarding%22%7D&redirect_uri=https%3A%2F%2Fwww.newcoworker.com%2Fapi%2Fintegrations%2Fmeta%2Fcallback
```

**Caveat before using it for real:** the auto-filled `redirect_uri` points
at the **Lead Ads** OAuth callback (`/api/integrations/meta/callback`),
which does not handle the WhatsApp Embedded Signup return (WABA/phone ids +
code). Sending a customer here today would land them on a callback that
can't finish the WhatsApp connect. If we adopt this path, point
`redirect_uri` at a WhatsApp-specific handler (or drop it and handle the
postMessage) first.

## Review / availability chain

- **Business Verification: APPROVED Jul 16, 2026.**
- **WhatsApp Tech Provider onboarding (independent): App Review SUBMITTED
  Jul 20, 2026 — "In review".** This is the same submission bundle
  (WhatsApp + Messenger/lead permissions) and it grants Advanced Access to
  `whatsapp_business_messaging` + `whatsapp_business_management`. Until Meta
  approves, only app role-holders/testers can complete Embedded Signup;
  arbitrary (non-role) customers hit "New Coworker can't onboard customers
  right now". Now waiting on Meta (WhatsApp Advanced Access is typically a
  few business days).
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
