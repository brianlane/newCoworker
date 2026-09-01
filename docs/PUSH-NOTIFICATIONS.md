# Web Push and the PWA

The first owner-alert channel we own end to end.

## Why it exists

Every other alert channel is somebody else's surface, and each one taxes us:

| Channel | Tax |
|---|---|
| SMS | metered per segment; a carrier receipt only proves a handset ACKed, never that a person read it |
| WhatsApp | pre-approved Meta template required outside the 24-hour service window, which is where owner alerts always land; metered; needs a funded WABA |
| Email | cannot be judged by replies at all, so liveness falls back to bounces |
| Slack | needs a workspace the business actually uses; its only signal is the owner happening to post |

Push has none of those, and one property none of them have: **a tap is a real
read receipt.** `notificationclick` fires on the owner's own device, from a
real gesture, on a subscription bound to an authenticated user row. That is
why `push` gets the tightest liveness threshold in the system (7 days, against
21 for sms/whatsapp/dashboard and 30 for slack): every other channel's signal
is a proxy that an attentive owner might simply never send.

## Architecture map

| Piece | Path |
|---|---|
| Manifest (metadata route) | `src/app/manifest.ts` → `/manifest.webmanifest` |
| Service worker | `public/sw.js` |
| Device registration (renders nothing) | `src/components/push/PushRegistrar.tsx` |
| Opt-in UI | `src/components/push/PushSetupCard.tsx` |
| Install/permission decision (pure) | `src/lib/push/install.ts` |
| Endpoint validation + SSRF allowlist | `src/lib/push/subscription.ts` |
| Payload contract with the worker | `src/lib/push/payload.ts` |
| VAPID env | `src/lib/push/keys.ts`, `src/lib/push/vapid.ts` |
| Table reads/writes | `src/lib/push/db.ts` |
| Delivery | `src/lib/push/send.ts` |
| Tier gate (Standard+) | `src/lib/push/tier-gate.ts` |
| Browser-facing routes | `src/app/api/push/{vapid-key,subscribe,unsubscribe,receipt}` |
| Deno→Node bridge | `src/app/api/internal/push-send` |
| Node dispatch leg | `src/lib/notifications/dispatch.ts` (leg 6) |
| Deno dispatch leg | `supabase/functions/notifications/index.ts` (leg 6) |
| Tables | `push_subscriptions` (20260829044304), `notification_link_clicks` (+20260829044306) |

## Env

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. All three or push is
unconfigured. `npx web-push generate-vapid-keys` produces a pair.

The public half is served from `GET /api/push/vapid-key`, deliberately not
`NEXT_PUBLIC_VAPID_PUBLIC_KEY`. A build-time key can skew from the server's
private key (a rotation without a redeploy, a preview built before the var
existed), and the result is that every subscription minted by that build is
permanently undeliverable with nothing client-side able to notice.

## Things that will bite you

**iOS delivers push only to a PWA on the Home Screen.** There is no
programmatic install prompt. Worse, outside a Home Screen app iOS Safari does
not expose `PushManager` at all, so a feature-detect-first implementation
concludes "unsupported" and hides the install coaching on exactly the devices
that need it. `installCoachState` therefore checks "iOS and not standalone"
**before** any capability check. iPadOS also reports a desktop Macintosh user
agent, so `maxTouchPoints` is the only thing separating an iPad from a Mac.

**A 403 from a push service must never revoke.** It means the VAPID key does
not match, which a botched rotation produces for the entire fleet at once.
Treating it like a 410 would wipe every subscription we hold in one dispatch.
Only 404 and 410 revoke; they are the authoritative "this subscription is
gone" signals.

**Every `push` event must end in a `showNotification`.** Chrome enforces the
`userVisibleOnly` contract the subscription was granted under, and repeated
violations revoke the permission.

**`public/sw.js` is not typechecked, bundled, or importable.** Two guards
stand in: `eslint.config.mjs` runs `no-undef` over it with serviceworker
globals and `sourceType: "script"` (the same block, and the same scar, as
`vps/**/*.mjs`), and `tests/service-worker-contract.test.ts` pins the payload
keys against `buildPushPayload` and checks every `/api` path it calls exists.

**The endpoint allowlist is an SSRF guard.** The server POSTs to a
client-supplied URL. Without it a signed-in owner can point us at an internal
address and read the result back through the delivery outcome.

**The Deno mirror is invisible to the compiler.** `tsconfig.json` excludes
`supabase/functions`. `tests/notifications-deno-parity.test.ts` is the only
thing comparing it to the Node dispatcher; if you add a channel, that test is
what stops the edge path from silently ignoring its preference column.

**View-as must not enroll the operator's phone.** `requireBusinessRole` lets
the platform admin past every tenant gate, and `PushRegistrar` silently
re-POSTs an already-granted subscription on every dashboard load. One "View
as tenant" visit in the installed PWA therefore used to attach HQ to that
tenant's alerts, which is how a Kin JaneApp tap landed on the admin lock
screen. Tenant enroll now requires a real roster role (owner_email or
`business_members`), the registrar is not mounted during non-selfOwned
view-as, and `deliverPush` drops (and membership-revokes) any leftover
non-member row. Revoke with `revokePushSubscriptionsForUser`, never by
endpoint alone: the same endpoint is shared with the admin's HQ/platform
row.

## Adding another channel later

The union in `src/lib/db/notifications.ts` is the source of truth, but the
compiler only enforces one downstream site (`CHANNEL_MAX_SILENCE_DAYS`). By
hand: both `gatedChannels` arrays in `dispatch.ts`, the Deno `DeliveryChannel`
type and its preferences select string, `defaults` in
`notification-preferences.ts`, the reason-label map in `NotificationList.tsx`,
and **both** CHECK sites in `vps/data-api/schema.sql`. Miss that last one and
a residency tenant's write journal wedges on the first row of the new channel.
