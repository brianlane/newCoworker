---
name: edge-admin-alert-email-stale
description: "Edge admin-alert email WAS stale (personal gmail, no ADMIN_ALERT_EMAIL); FIXED Aug 27 2026 after the first-ever call-integrity sweep send; Vercel env and Edge secrets are separate stores"
metadata: 
  node_type: memory
  type: project
  originSessionId: 43b142fd-d438-406b-9852-7437b5d25781
  modified: 2026-08-27T18:39:44.434Z
---

Found 2026-08-27 when the call-integrity sweep's first-ever alert email
landed in Brian's PERSONAL Gmail (brianlane2@gmail.com) instead of the admin
inbox (newcoworkerteam@gmail.com).

**Two email environments exist and they drifted.** The app (Vercel / repo
`.env`) has `ADMIN_EMAIL=newcoworkerteam@gmail.com` and
`CONTACT_EMAIL=contact@newcoworker.com`. The Supabase EDGE FUNCTION secrets
(`supabase secrets list`, digests are SHA-256 of the value, verifiable with
`printf '%s' "value" | shasum -a 256`) hold older values:

- `ADMIN_EMAIL` = `brianlane2@gmail.com` (digest 754e13c9...)
- `CONTACT_EMAIL` = `newcoworkerteam@gmail.com` (digest d6c63b03...)
- `ADMIN_ALERT_EMAIL` = not set at all

**Recipient resolution** (`supabase/functions/_shared/admin_alert_email.ts`
and the two older inline copies): `ADMIN_ALERT_EMAIL` then `ADMIN_EMAIL`
then `CONTACT_EMAIL`. With no ADMIN_ALERT_EMAIL, everything falls to the
stale personal address.

**Why it went unnoticed for months:** no Edge path had ever sent an admin
alert. Telemetry proves it: `call_integrity_sweep` ran daily since Aug 18
with findings=0 until 2026-08-27 13:40Z, and `chat-spend-velocity-alerts` /
`voice-capacity-monitor` have zero telemetry events ever. The first real
finding was the first send.

**Blast radius while stale:** call-integrity sweep alerts,
chat-spend-velocity alerts, voice-capacity alerts, plus the per-business
LAST-RESORT recipient in `notifications` (fallbackEmail) and
`notifications-digest` (adminEmail) when a business has no owner email.

**FIXED 2026-08-27** (safe because in the Edge environment `ADMIN_EMAIL` is
used ONLY as a recipient/fallback, never for auth; admin login gating on
ADMIN_EMAIL is app-side Vercel env, a different store): `supabase secrets
set` now holds `ADMIN_EMAIL=newcoworkerteam@gmail.com`,
`ADMIN_ALERT_EMAIL=newcoworkerteam@gmail.com` (explicit), and
`CONTACT_EMAIL=contact@newcoworker.com` (reply-to realignment only, the
Cloudflare catch-all forwards it to the team Gmail anyway, see
[[project_email_routing_catchall_is_the_product]]). Verified by digest
match and by a live sweep send the same day reporting `alert: "sent"` with
the new values in effect.

**How to apply:** when an alert path "has always worked", check whether it
has ever actually FIRED before trusting its configuration; and when adding
an env-driven recipient, remember Vercel env and Supabase Edge secrets are
separate stores that do not sync. Related:
[[project_ai_invents_callback_numbers_on_voicemail]].
