# Release notes for Zoom resubmission (paste into the submission form)

## What changed since the previous submission (withdrawn 2026-07-17)

One scope was ADDED: `cloud_recording:read:meeting_transcript`.

WHY: New Coworker now offers owner-initiated meeting minutes. On
Dashboard → Integrations → Zoom, the connected owner can paste the meeting ID
of one of THEIR OWN cloud-recorded meetings; the app fetches that meeting's
transcript (GET /meetings/{meetingId}/transcript, then the returned
download_url) and condenses it into meeting minutes stored in the owner's
document library. Transcripts are read ONLY on an explicit per-meeting import
click — nothing is polled, subscribed to, or pulled automatically, and no
other recording data (video/audio files, recording lists) is requested.

The scope is exercised end-to-end by Step 6 of the reviewer test plan:
https://www.newcoworker.com/integrations/zoom/review-test-plan

## Standing submission details (unchanged)

1. ACCOUNT TYPE: The submitting Zoom account is "Free with Credit Card".

2. TEST PLAN: A step-by-step reviewer walkthrough covering authorization,
every requested scope (meeting create / update / delete / read, invite links,
user read, meeting transcript read), and removal:
https://www.newcoworker.com/integrations/zoom/review-test-plan

3. TEST CREDENTIALS (reviewer account on our production environment, which
uses the Production Client ID for authorization):
URL: https://www.newcoworker.com/login
Email: zoom.reviewer@newcoworker.com
(The reviewer account's sign-in credential is NOT stored in this repo — it is
submitted directly in the Zoom form. Re-mint it with
`tsx debug/zoom-reviewer-setup.ts --apply` if it is ever lost.)
The account owns a pre-configured sandbox business ("Zoom Review Sandbox")
with dashboard access to the Integrations page and the booking chat used in
the test plan. Connect any Zoom account (a free account works) in Step 2 of
the plan; for Step 6 the connected account needs cloud recording with audio
transcript available.

4. DOCUMENTATION URL: End-user documentation covering how to add, use, and
remove the integration (updated for the transcript-import feature):
https://www.newcoworker.com/integrations/zoom

5. CONTACT EMAIL: team@newcoworker.com.

6. DEV / PROD REDIRECT URLS: The production redirect URL is
https://www.newcoworker.com/api/integrations/zoom/callback.

TLS: all endpoints are HTTPS-only and negotiate TLS 1.2 or higher (HSTS
preload enabled).

Security evidence (SSDLC, SAST & DAST results, privacy policy, security
policy, vulnerability management procedures, infrastructure/dependency
management policy) is attached in the Technical Design section from the
previous resubmission. Transcript content is stored in the same
RLS-protected, AES-256-GCM-encrypted document store described there and is
deleted on request.
