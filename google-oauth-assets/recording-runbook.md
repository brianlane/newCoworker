# Google OAuth demo video: staging + recording runbook (stop-and-go)

The Jul 24 rejection said the previous video "does not sufficiently
demonstrate the functionality of your app". This runbook produces the
replacement. Roles: the agent stages every scene off-camera; you only record.
Record at normal speed, English narration, no cuts around the consent
screen, upload to YouTube as UNLISTED (not Private).

## Phase 0: pre-record cleanup (agent + you, off-camera)

1. DONE (Jul 24): `gmail.settings.basic` removed from the Nango `google`
   integration; it now requests exactly `calendar.events`, `gmail.modify`,
   and the sign-in identity scopes.
2. YOU (agent can drive via Browser MCP if connected): in the Cloud console
   (`new-coworker` project) open Google Auth Platform -> Data Access and
   REMOVE `https://www.googleapis.com/auth/gmail.settings.basic` from the
   declared scopes, then save. The declared set must be exactly
   `calendar.events` + `gmail.modify` (+ identity scopes).
3. AGENT: verify the consent screen in a fresh incognito connect attempt
   from the sandbox (do not complete the grant): app name "New Coworker",
   exactly the two data scopes listed, client id `354099628168-...` in the
   URL.
4. AGENT: stage the demo tenant (HQ, `newcoworkerteam@gmail.com`, demo line
   +1 602 313 1823): disconnect Google on Dashboard -> Integrations ->
   Workspace so Shot 2 shows a clean connect; confirm an email-triggered
   flow is enabled and bound to the mailbox; confirm a bookable slot exists
   for "tomorrow 2pm".
5. AGENT: hand you the narration lines below plus the exact booking ask and
   the test customer email (subject matching the flow condition).

## Shot list (what the reviewer must see)

- **Shot 1, ~20s, context.** "New Coworker (newcoworker.com) is an AI
  coworker for small businesses. The business owner connects their own
  Google account so the coworker can book appointments on their calendar
  and handle their business inbox. All access is server-side, and the owner
  can disconnect at any time."
- **Shot 2, the grant.** Log in at newcoworker.com -> Dashboard ->
  Integrations -> Workspace -> Connect workspace -> Google. Show the FULL
  consent screen unedited, and hold the browser URL bar long enough that
  `client_id=354099628168-...` is readable (this ties the grant to the
  verified client). Complete the grant; land back on the dashboard showing
  the connected account email.
- **Shot 3, calendar.events.** In Dashboard -> Chat ask: "Book an
  appointment for John Smith tomorrow at 2pm, 30 minutes, phone
  +1 555 010 0000." Show the confirmation, then switch to Google Calendar
  and show the new event on the connected account. Narrate: availability
  search plus create/update/delete is why read-only or free/busy scopes
  cannot power this.
- **Shot 4, gmail.modify.** Agent sends the staged customer email. Show:
  the email arriving in the connected Gmail inbox (unread); the flow
  picking it up (Dashboard -> Emails shows it as a trigger); the AI reply
  in the Gmail SENT folder (sent from the owner's own address); and the
  original message now MARKED READ in the inbox. Narrate: "The coworker
  reads the customer email, replies from the owner's own address, and
  marks the original handled. Reading alone cannot send, sending alone
  cannot read or mark handled; gmail.modify is the single scope that
  covers this loop. No data is used for ads, sold, or used to train
  generalized AI models."
- **Shot 5, ~10s, close.** "One Google Cloud project, one OAuth client,
  owner-only connections, disconnect available in the dashboard."

## Stop-and-go sequence

1. GO (agent): Phase 0 items 3-5. STOP.
2. GO (you): record Shots 1-2. STOP; tell the agent the grant completed.
3. GO (agent): verify the fresh connection (calendar resolvable, slot
   free), give you the exact booking ask. STOP.
4. GO (you): record Shot 3. STOP.
5. GO (agent): send the staged customer email, confirm the flow will fire
   within the minute. STOP.
6. GO (you): record Shots 4-5, then trim and upload UNLISTED. STOP.
7. GO (agent+you): fill `[VIDEO_URL]` and `[REVIEWER_PASSWORD]` in
   `verification-reply.md` (re-mint with
   `tsx debug/google-reviewer-setup.ts --apply`), send the reply on the
   verification email thread, paste the same video link in Data Access ->
   Demo video, and re-confirm the Verification Center submission.

## Reviewer sandbox state (already provisioned, Jul 24)

- Login `google.reviewer@newcoworker.com` on "Google Review Sandbox
  (internal)" (`e2b7a1c4-0000-4000-8000-000000000003`); no MFA. Password
  rotates on every `debug/google-reviewer-setup.ts --apply`.
- Seeded DISABLED flow "Google review demo: inbound email" (trigger:
  subject contains "Review test"; steps: extract_text + send_email reply
  from the owner mailbox). Its mailbox bindings are placeholders BY DESIGN:
  the reviewer picks their just-connected mailbox in the builder (trigger
  mailbox + Send from), which save-time binding validation enforces.
- Keep the sandbox free of pre-connected Google accounts so the reviewer's
  own grant is the only connection (calendar resolution unambiguous, and
  they see the Sent copy and mark-read in their own mailbox).

## Post-approval queue

- CASA Tier 2 self-assessment (required for gmail.modify): reuse the
  `zoom-marketplace-assets/` evidence pack (ZAP DAST, SAST, SSDLC,
  policies).
- Known risk: `nango.dev` sits in authorized domains via the
  `api.nango.dev` redirect. If reviewers demand Search Console ownership,
  the fix is Nango's custom callback domain or a Zoom-style direct OAuth
  migration. Do not do preemptively.
