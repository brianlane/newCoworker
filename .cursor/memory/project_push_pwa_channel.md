---
name: project-push-pwa-channel
description: Web Push is the sixth alert channel and the only true read receipt; the traps are iOS ordering, 403-never-revokes, the SSRF allowlist, the invisible Deno mirror, and view-as must not enroll the operator's phone
metadata:
  type: project
---

Shipped 2026-08-28. The PWA (`src/app/manifest.ts`, `public/sw.js`) plus
`push` as a sixth `notifications.delivery_channel`. Full map in
`docs/PUSH-NOTIFICATIONS.md`.

**Why it matters beyond one more pipe.** A `notificationclick` fires on the
owner's device, from a real gesture, on a subscription bound to an
authenticated user row. It is the ONLY true read receipt any channel here
produces; everything else infers engagement from a reply that may never come.
That is why push gets a 7-day liveness threshold against 21 for
sms/whatsapp/dashboard and 30 for slack. Receipts land in
`notification_link_clicks` with `channel='push'`, the table already built for
owner clicks. Do NOT stamp `notifications.read_at` for this: `lastDashboardReadAt`
reads the newest non-admin `read_at` tenant-wide, so a push tap would certify
the DASHBOARD as live, which is the WhatsApp-lead bug one channel over.

**Traps, each of which ships green and fails silently:**

- **iOS ordering.** Outside a Home Screen app, iOS Safari does not expose
  `PushManager`. Feature-detecting BEFORE checking `standalone` returns
  "unsupported" and hides the install coaching on exactly the devices that
  need it. `installCoachState` checks iOS-and-not-installed first. iPadOS also
  reports a desktop Macintosh UA, so `maxTouchPoints > 1` is the only tell.
- **403 must never revoke.** It means the VAPID key does not match, which a
  botched rotation produces fleet-wide at once; treating it like a 410 wipes
  every subscription in one dispatch. Only 404/410 revoke. Serving the public
  key from `/api/push/vapid-key` (not `NEXT_PUBLIC_*`) is what makes recovery
  automatic, and is why a baked build-time key is wrong.
- **SSRF.** The server POSTs to a client-supplied `endpoint`, so
  `isAllowedPushEndpoint` host-allowlists with dot-anchored suffixes;
  `fcm.googleapis.com.evil.test` must fail.
- **`unique nulls not distinct`** on `(business_id, endpoint)` is load-bearing
  for the HQ-admin `business_id IS NULL` scope. Production is PG 17.6.
  PostgREST needs `.is("business_id", null)`; `.eq(...,null)` matches zero rows
  silently. See [[project_postgrest_write_matching_zero_rows]].
- **`maybeSingle` is still forbidden** on `push_subscriptions`: it is one row
  per DEVICE, and copying the Slack leg's `maybeSingle` errors for anyone with
  two phones, swallowed by the fail-open guard. `pushTargetState` now reads
  the live list (not a single sampled row) so a leaked HQ-admin device sitting
  next to the owner's phone cannot decide deliverable for the wrong user.
- **View-as must not enroll the operator's phone.** `requireBusinessRole`
  lets the admin past every tenant gate, and `PushRegistrar` silently re-POSTs
  an already-granted subscription. One inspect visit in the installed PWA
  attached HQ to Kin and every later lead-tap alert landed on the operator
  lock screen. Tenant enroll requires a REAL roster role; the registrar is
  not mounted during non-selfOwned view-as; `deliverPush` membership-revokes
  leftover non-member rows. Never revoke by endpoint alone: the same
  endpoint is shared with the admin's HQ/platform row. Deno cannot import
  that helper, so it asks `/api/internal/push-target-state` before it
  decides `push_replaces_sms`. An unfiltered live-row check there would
  skip SMS, then the send would drop the leaked device, and the owner
  would get neither. See `src/lib/push/eligibility.ts`.

**The widening ripples further than the compiler sees.** Only
`CHANNEL_MAX_SILENCE_DAYS` is a `Record` over the union. By hand: both
`gatedChannels` arrays in `dispatch.ts`, the Deno `DeliveryChannel` + its prefs
select string, `defaults` in `notification-preferences.ts`, the
`NotificationList` reason map, and **both** CHECK sites in
`vps/data-api/schema.sql`. That last one wedges a residency tenant's entire
write journal on the first row of the new channel.

Three guards added that outlive this work:
`tests/notifications-deno-parity.test.ts` (nothing compared the two
dispatchers before; `tsconfig` excludes `supabase/functions`),
CHECK-value parity in `tests/residency-box-schema-columns.test.ts` derived from
the TS union, and `UPDATABLE_PREFERENCE_KEYS` as a
`Record<keyof Required<NotificationPreferencesUpdate>, true>` so a forgotten
column is a compile error instead of a save that returns 200 and changes
nothing. See [[project_agent_tool_parity_four_way]] for the same class of
multi-file drift.

Deliberately NOT done: no `push_digest` (a banner is an interrupt, and a daily
push nobody taps would push a healthy tenant past the 10-send floor and make
the best-evidence channel read `silent`); push is not in
`src/lib/owner-surfaces/registry.ts` (that registry is about surfaces the owner
TALKS TO the coworker from, and push takes no turn).
