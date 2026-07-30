# Google OAuth demo video: staging + recording runbook (stop-and-go)

The Jul 24 rejection said the previous video "does not sufficiently
demonstrate the functionality of your app". This runbook produces the
replacement. Roles: the agent stages every scene off-camera; you only record.
Record at normal speed, English narration, no cuts around the consent
screen, upload to YouTube as UNLISTED (not Private).

Scope-set note (Jul 26, 2026): the booking page re-added the two
non-sensitive granular calendar scopes, so the FINAL declared set is
`calendar.events.freebusy` + `calendar.app.created` + `calendar.events` +
`gmail.modify` + identity. Do not trim scopes again; the video and the
justifications are built around this set.

## Phase 0: pre-record cleanup (status)

1. DONE (Jul 24): `gmail.settings.basic` and the unused add-on/label scopes
   removed from Nango and the console.
2. DONE (Jul 26): console Data Access matches Nango exactly (the 7-scope
   set above); `calendar.events` justification rewritten for the
   three-calendar-scope split; save confirmed ("Data access changes
   saved!").
3. DONE (Jul 26): consent screen verified against the live client: exactly
   seven permission lines (secondary calendars, availability, view/edit
   events, Gmail read/compose/send, and the three identity lines).
4. AGENT (before recording): stage the demo tenant (HQ,
   `newcoworkerteam@gmail.com`, demo line +1 602 313 1823): disconnect
   Google on Dashboard -> Integrations -> Workspace so Shot 2 shows a clean
   connect (revoke the app at myaccount.google.com -> Security ->
   Third-party access first, so the full consent screen renders); confirm
   the email-triggered demo flow and booking page are ready; confirm a
   bookable slot and stage a pre-existing appointment ON THE PRIMARY
   calendar for the reschedule shot.
5. AGENT: after the on-camera reconnect, re-point the HQ flows (triage +
   "Google review demo reply (HQ)") at the new connection id (a
   disconnect deletes the old row, so bindings must be re-pointed), enable
   the demo reply flow, then hand over the booking ask and test email.

## Shot list (what the reviewer must see)

- **Shot 1, ~20s, context.** "New Coworker (newcoworker.com) is an AI
  coworker for small businesses. The business owner connects their own
  Google account so the coworker can book appointments, run a public
  booking page, and handle their business inbox. All access is server-side,
  and the owner can disconnect at any time."
- **Shot 2, the grant.** Log in at newcoworker.com -> Dashboard ->
  Integrations -> Workspace -> Connect workspace -> Google. Show the FULL
  consent screen unedited (all seven permission lines), and hold the
  browser URL bar long enough that `client_id=354099628168-...` is
  readable. Complete the grant; land back on the dashboard showing the
  connected account email.
- **Shot 3, calendar.app.created + calendar.events.** In Dashboard -> Chat
  ask: "Book an appointment for John Smith tomorrow at 2pm, 30 minutes,
  phone +1 555 010 0000." Show the confirmation, then Google Calendar with
  the new event on the app-created "NewCoworker" calendar. Narrate: "New
  bookings land on a calendar the app created itself, under the
  calendar.app.created scope." Then exercise `calendar.events`: ask the
  coworker to move the pre-staged appointment that lives on the PRIMARY
  calendar ("Move my 4pm consult to 5pm") and show it moved in Google
  Calendar. Narrate: "Appointments on the owner's own calendar can only be
  managed with calendar.events; free/busy cannot create, move, or cancel
  anything, and app.created cannot touch the owner's own calendars."
- **Shot 4, calendar.events.freebusy (booking page).** Open the business's
  public booking link (`/book/<token>`) in a fresh window, show the open
  slots, and book one as a visitor. Narrate: "The public booking page
  computes availability from the owner's free/busy data only, under
  calendar.events.freebusy; visitors never see event details." Show the
  booking landing on the NewCoworker calendar.
- **Shot 5, gmail.modify.** Agent sends the staged customer email. Show:
  the email arriving in the connected Gmail inbox (unread); the flow
  picking it up (Dashboard -> Emails shows it as a trigger); the AI reply
  in the Gmail SENT folder (sent from the owner's own address); the
  original message now MARKED READ; and, when the flow includes
  email_organize, a label applied or the message archived out of Inbox.
  Narrate: "The coworker reads the customer email, replies from the
  owner's own address, marks the original handled, and can apply the
  owner's labels or archive as the flow directs. Reading alone cannot
  send, sending alone cannot read, label, or mark handled; gmail.modify
  is the single scope that covers this loop. No data is used for ads,
  sold, or used to train generalized AI models."
- **Shot 6, ~10s, close.** "One Google Cloud project, one OAuth client,
  owner-only connections, disconnect available in the dashboard."

## Stop-and-go sequence

1. GO (agent): Phase 0 items 4-5 prep (staging + scripts). STOP.
2. GO (you): record Shots 1-2. STOP; tell the agent the grant completed.
3. GO (agent): re-point flow bindings to the new connection, enable the
   demo reply flow, verify the calendar and booking page, stage the
   primary-calendar appointment, give you the exact asks. STOP.
4. GO (you): record Shots 3-4. STOP.
5. GO (agent): send the staged customer email, confirm the flow will fire
   within the minute. STOP.
6. GO (you): record Shots 5-6, then trim and upload UNLISTED. STOP.
7. GO (agent+you): fill `[VIDEO_URL]` and `[REVIEWER_PASSWORD]` in
   `verification-reply.md` (re-mint with
   `tsx debug/google-reviewer-setup.ts --apply`), send the reply on the
   verification email thread, paste the same video link in Data Access ->
   Demo video, and re-confirm the Verification Center submission.

## Reviewer sandbox state (provisioned Jul 24)

- Login `google.reviewer@newcoworker.com` on "Google Review Sandbox
  (internal)" (`e2b7a1c4-0000-4000-8000-000000000003`); no MFA. Password
  rotates on every `debug/google-reviewer-setup.ts --apply`.
- Seeded DISABLED flow "Google review demo reply (HQ mirror)": trigger
  subject contains "Review test"; steps extract_text + send_email reply
  from the owner mailbox. Its mailbox bindings are placeholders BY DESIGN:
  the reviewer picks their just-connected mailbox in the builder (trigger
  mailbox + Send from), which save-time binding validation enforces.
- Keep the sandbox free of pre-connected Google accounts so the reviewer's
  own grant is the only connection (calendar resolution unambiguous, and
  they see the Sent copy and mark-read in their own mailbox). The booking
  page auto-provisions the first time the reviewer opens Dashboard ->
  Bookings.

## Post-approval queue

- CASA Tier 2 self-assessment (required for gmail.modify): reuse the
  `zoom-marketplace-assets/` evidence pack (ZAP DAST, SAST, SSDLC,
  policies).
- CONFIRMED (Jul 27): Supabase-Auth "Log in with Google" (PR #942) uses
  this same client, so sign-in usage is stated in the reply and shown as a
  beat in the video; keep its redirect URI on the client config.
- Known risk: `nango.dev` sits in authorized domains via the
  `api.nango.dev` redirect. If reviewers demand Search Console ownership,
  the fix is Nango's custom callback domain or a Zoom-style direct OAuth
  migration. Do not do preemptively.
