# Zoom deauthorization webhook + data compliance (planned fast follow)

Status: IMPLEMENTED (Jul 2026) as part of the automatic-meeting-minutes
webhook build: `/api/webhooks/zoom` handles `app_deauthorized` alongside
`recording.transcript_completed` (core in `src/lib/zoom/webhook.ts`). The
sections below are the original plan, kept for the rationale and the
rollout caution. Written 2026-07-24, the day "New Coworker OAuth" was
approved and published on the Zoom App Marketplace
(listing: https://marketplace.zoom.us/apps/il8znyqrQ1y7GdkFnZ11dg).

## Why

The app's manifest currently ships an EMPTY `event_subscription`
(`zoom-marketplace-assets/zoom-app-manifest.json`). When a customer removes
the app from Zoom's side (marketplace.zoom.us, Manage, Added Apps, Remove),
we get no signal: the connection row stays `is_active=true` until the next
token refresh fails with `invalid_grant` and soft-disables it
(`src/lib/zoom/oauth.ts`, `src/lib/zoom/client.ts`). That can lag by up to an
hour of token lifetime plus however long until the next Zoom API call for
that tenant. Published marketplace apps are expected to consume the
`app_deauthorized` event and honor Zoom's data-deletion expectations.

## What Zoom sends

- All webhook deliveries go to one Event notification endpoint URL
  configured on the marketplace app.
- On save/validation, Zoom POSTs `endpoint.url_validation` with a
  `plainToken`; the endpoint must reply 200 with
  `{ plainToken, encryptedToken: HMACSHA256hex(plainToken, SECRET_TOKEN) }`.
- Every event carries `x-zm-request-timestamp` and `x-zm-signature`
  (`v0=` + HMAC-SHA256 hex of `v0:{timestamp}:{rawBody}` keyed by the app's
  Secret Token). Verify before parsing; reject stale timestamps (>5 min).
- The `app_deauthorized` payload identifies the deauthorizing user/account
  (`payload.user_id`, `payload.account_id`, `deauthorization_time`,
  `signature`).

The app's Secret Token already exists in the env as `ZOOM_SECRET_TOKEN`
(captured at app creation); the webhook build must use it, not mint anything
new.

## Build sketch

1. Route `src/app/api/webhooks/zoom/route.ts` (POST only):
   - raw-body HMAC verification + timestamp freshness, then dispatch;
   - `endpoint.url_validation`: answer the challenge;
   - `app_deauthorized`: look up `zoom_connections` by `zoom_user_id`
     (fallback: nothing found is a no-op 200), then
     `setZoomConnectionActive(businessId, false)` so the dashboard card
     flips to "Needs reconnect", and blank/delete the stored token pair
     (tokens are dead at Zoom the moment the user deauthorizes; keeping
     ciphertext buys nothing);
   - telemetry event (`zoom_deauthorized`) so admin dashboards can see
     uninstall volume;
   - unknown event types: 200 and ignore (Zoom retries non-2xx).
2. Data deletion posture: transcript-derived meeting minutes in Documents
   were created by the OWNER importing their own meeting and belong to the
   tenant's document library, so uninstalling Zoom does not auto-delete
   them. Verified end-user erasure keeps riding the existing
   `src/lib/privacy/deletion.ts` path. If Zoom's current publisher terms
   require a Data Compliance API acknowledgement for deauthorization
   events, wire it in the same route (check the current requirement at
   build time; the legacy `POST /oauth/data/compliance` endpoint was
   retired for most app types).
3. Tests: signature verify (valid, tampered, stale), url_validation
   challenge, deauthorize flow against a seeded connection, unknown-event
   no-op. Core logic lives under `src/lib/zoom/` (coverage gate).

## Rollout caution (the reason this is NOT bundled casually)

Adding an event subscription changes the marketplace app configuration,
which re-enters the update-review flow (the same withdraw/resubmit dance as
the Jul 18 transcript-scope addition). Do it deliberately:

- bundle this config change with the NEXT planned Zoom app change if one is
  near, or ship it alone during a quiet week;
- deploy the endpoint to production FIRST (it must answer
  `endpoint.url_validation` before Zoom will save the subscription);
- reuse the review machinery: reviewer account
  (`debug/zoom-reviewer-setup.ts`), sandbox business, test plan page
  (add a deauthorization step), release notes in
  `zoom-marketplace-assets/`;
- until the update is approved, production behavior is unchanged (the
  refresh-failure fallback keeps working).
