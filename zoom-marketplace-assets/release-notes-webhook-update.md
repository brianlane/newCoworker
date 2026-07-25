# Release notes for the Zoom update submission (paste into the form)

## What changed since the approved 2026-07-24 publication

ONE scope was ADDED: `meeting:read:past_meeting`.

WHY: Zoom's transcript endpoint (GET /meetings/{id}/transcript) resolves a
NUMERIC meeting ID only for scheduled meetings; for instant/ended meetings it
returns 404 (code 3322) and only the past-meeting instance UUID resolves. When
the connected owner pastes one of THEIR OWN meeting IDs into the minutes
import, the app now calls GET /past_meetings/{meetingId} once to translate the
ID to its instance UUID, then fetches the transcript exactly as before. The
same UUID keys the server-side de-duplication between manual imports and the
automatic webhook import. No other past-meeting data (participants, polls,
details beyond the uuid field) is read or stored. Exercised by Step 6 of the
reviewer test plan (paste the numeric meeting ID of an instant meeting).

One EVENT SUBSCRIPTION was also added, with two events:

1. `recording.transcript_completed` - powers automatic meeting minutes.
   When the connected owner cloud-records one of THEIR OWN meetings with
   audio transcript on, the app imports the finished transcript and stores
   condensed meeting minutes in the owner's document library (visible to
   their staff only). The feature is owner-controlled: an "Automatic
   meeting minutes" switch on Dashboard -> Integrations -> Zoom (on by
   default, one click to turn off). The transcript is fetched with the
   already-approved `cloud_recording:read:meeting_transcript` scope; no
   other recording data (video/audio files, recording lists) is requested.
   Redelivered events are deduplicated server-side.

2. `app_deauthorized` - compliance hygiene. When a user removes the app
   from the Zoom Marketplace, the stored (now dead) token pair is wiped
   immediately and the dashboard shows the connection as disconnected,
   instead of waiting for the next token refresh to fail.

The endpoint (https://www.newcoworker.com/api/webhooks/zoom) verifies the
`x-zm-signature` HMAC with the app's Secret Token on every delivery,
enforces a 5-minute timestamp window, and answers the
`endpoint.url_validation` challenge.

Both events are exercised by the updated reviewer test plan (Step 7 for
automatic minutes, Step 8 for deauthorization):
https://www.newcoworker.com/integrations/zoom/review-test-plan

## Standing submission details (unchanged)

1. ACCOUNT TYPE: The submitting Zoom account is "Free with Credit Card".

2. TEST PLAN: https://www.newcoworker.com/integrations/zoom/review-test-plan

3. TEST CREDENTIALS (reviewer account on our production environment, which
uses the Production Client ID for authorization):
URL: https://www.newcoworker.com/login
Email: zoom.reviewer@newcoworker.com
(The reviewer account's sign-in credential is NOT stored in this repo - it
is submitted directly in the Zoom form. Re-mint it with
`tsx debug/zoom-reviewer-setup.ts --apply` if it is ever lost.)

4. DOCUMENTATION URL (updated for automatic meeting minutes):
https://www.newcoworker.com/integrations/zoom

5. CONTACT EMAIL: team@newcoworker.com.

6. DEV / PROD REDIRECT URLS: The production redirect URL is
https://www.newcoworker.com/api/integrations/zoom/callback.

TLS: all endpoints are HTTPS-only and negotiate TLS 1.2 or higher (HSTS
preload enabled). Transcript content is stored in the same RLS-protected,
AES-256-GCM-encrypted document store described in the Technical Design
evidence and is deleted on request.
