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
- **App Review APPROVED.** Submitted Jul 20, 2026; decided Aug 11, 2026.
  The bundle granted Advanced Access to `whatsapp_business_messaging` +
  `whatsapp_business_management` plus the Messenger/Instagram DM, `pages_*`,
  `public_profile`, and `leads_retrieval` permissions, so Embedded Signup
  and the direct Meta connect now work for any customer (no app role or
  tester status needed).
- **Next submission (staged, not yet sent).** Meta's own requirement list
  for the "Capture & manage ad leads with Marketing API" use case is
  `public_profile`, `ads_management`, `ads_read`, Marketing API Access Tier,
  `business_management`, `leads_retrieval`, `pages_manage_ads`,
  `pages_read_engagement`, `pages_show_list` — the Aug 11 approval covered
  only five of those nine, so `ads_management`, `ads_read`,
  `business_management` and the tier still need requesting. Add
  `instagram_manage_comments` (the IG comment webhook already fires
  `instagram_comment` AiFlow triggers) and re-request
  `instagram_content_publish`. **Delete everything else from the cart**: the
  ~30 other staged items are the optional extras that ride along when a use
  case is added (branded content, creator marketplace, insights, catalog,
  shopping, the `instagram_business_*` family — that is the Instagram-Login
  flavor, we use Instagram through Facebook Login — `pages_manage_posts`,
  `pages_manage_engagement`, `pages_read_user_content`, `email`, the
  `pages_user_*` trio, and the marketing-messaging permissions). No code path
  touches any of them, and asking for permissions you cannot demonstrate is
  itself a rejection reason. The tier threshold is 500 Marketing API calls in
  the PAST 15 DAYS. DONE: the Aug 17 submission (trimmed to exactly this
  cart) was decided Aug 25, 2026 and the tier plus `ads_management`,
  `business_management`, `instagram_manage_comments`, and
  `instagram_content_publish` are all live at Advanced Access, so the
  keep-warm grind is retired.
- **`page_events` / `pages_events` is NOT needed and cannot be obtained.**
  See the README's direct-connection section: the dataset endpoint that
  demands it is undocumented, and the permission belongs to no use case.
- **`instagram_content_publish` was rejected Aug 11 and CLEARED Aug 25,
  2026** on resubmission: Instagram publishing is open to any connected
  account, no app role needed. The only rejection still standing is
  `ads_read` ("Screencast Not Aligned with Use Case Details", Developer
  Policy 1.6), and it blocks nothing: `ads_management`, which is approved,
  authorizes every ads read the code makes. To regain it anyway: re-record
  showing the complete Meta login flow, the grant screen with the
  permission, and the end-to-end use case (English UI with captions per the
  Screen Recording Guide), state per Meta's own rejection guidance that the
  app reads ads data server-to-server with stored tokens so no frontend
  login appears in normal operation, then "Request again" on the submission
  feedback page. Its Testing row stays warm until ~Sep 23 from the Aug 24
  test calls.
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
