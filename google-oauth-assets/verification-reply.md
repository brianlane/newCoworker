# Google OAuth verification: reply to the Trust and Safety email

Paste the text below (after filling the two placeholders) as a direct reply
on the "[Action Needed] OAuth Verification Request Acknowledgement" thread
for project `new-coworker`. Placeholders:

- `[REVIEWER_PASSWORD]`: mint with `tsx debug/google-reviewer-setup.ts --apply`
  right before sending (the credential is never stored in this repo).
- `[VIDEO_URL]`: the re-recorded unlisted YouTube demo video.

Keep the same video link and credentials in the Verification Center
submission so the two channels never disagree.

---

Hello,

Thank you for the review. We have addressed each item below for project
`new-coworker` (single OAuth web client `354099628168-j492f9g632aa...`).

## 1. Scope alignment (discrepancy resolved)

We audited the authorization request against the console configuration and
removed `https://www.googleapis.com/auth/gmail.settings.basic` from both. No
feature ever called a Gmail settings endpoint, so it has been dropped rather
than justified. The OAuth client now requests exactly the scopes declared in
Data Access, nothing more:

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/gmail.modify`
- `openid`, `userinfo.email`, `userinfo.profile` (sign-in identity only)

## 2. Scope justifications (feature to scope)

New Coworker (https://www.newcoworker.com) is an AI coworker for small
businesses. Only the business OWNER connects their Google account (Dashboard
-> Integrations); customers of the business never grant access.

**calendar.events.** Feature: the coworker answers the business phone, SMS,
and web chat, finds an open slot on the owner's calendar, and books,
reschedules, or cancels the appointment for the customer. It must therefore
search events for availability and create, update, and delete events on the
owner's calendar. `calendar.events.readonly` cannot write bookings and
`calendar.freebusy` cannot create, move, or cancel events, so neither
narrower scope supports the feature.

**gmail.modify.** Feature: the owner points automations at their business
inbox; when a customer email arrives, the coworker reads it, sends the reply
FROM the owner's own Gmail address (so the customer sees the business
address, not a third-party sender), and marks the original message read so
the owner's inbox shows it was handled. That is one read (messages.list /
messages.get), one send (messages.send), and one label change
(messages.modify, removing UNREAD) per handled email. `gmail.readonly`
cannot send or mark handled; `gmail.send` cannot read the inbound email or
mark it handled; combining them still cannot update the message state. The
single narrowest scope that covers read + send + label change is
`gmail.modify`, and we request nothing beyond those three operations (no
settings, no deletion, no full mailbox access via mail.google.com).

## 3. Test credentials (no authentication blockers)

Reviewer account on our production environment, which authorizes through the
production client above:

- URL: https://www.newcoworker.com/login
- Email: google.reviewer@newcoworker.com
- Password: [REVIEWER_PASSWORD]

The account has no 2FA, no phone verification, and no CAPTCHA on login. It
owns a pre-configured sandbox business with the Integrations page and an
enabled email-triggered flow. A step-by-step walkthrough covering the grant,
each scope in use, and removal is published at:
https://www.newcoworker.com/integrations/google/review-test-plan

## 4. Demo video

Updated demo video (unlisted): [VIDEO_URL]

It shows, in order and without cuts around the consent screen: the app
context, the full OAuth grant from Dashboard -> Integrations with the
browser URL bar visible (client id identifiable) and the complete consent
screen, `calendar.events` in use (booking by chat, then the event shown on
the owner's Google Calendar), and `gmail.modify` in use (inbound customer
email read by the coworker, the AI reply visible in the owner's Gmail Sent
folder, and the original message marked read), ending with disconnect.

## 5. Limited Use and AI disclosures

- **Transfer of user data to AI tools.** Gmail message content and calendar
  availability are processed server-side by the Gemini API (Google's paid
  API, which does not use submitted data to train models) solely to draft
  the owner's replies and to book appointments, i.e. to provide the
  user-facing features above. As a fallback, a small language model running
  on the tenant's own dedicated, single-tenant server can draft replies;
  that model is self-hosted on hardware dedicated to that business and no
  Workspace data leaves our infrastructure for it.
- **No training.** Google user data is never used to develop, improve, or
  train generalized AI or ML models, ours or anyone else's.
- **No ads, no sale.** Google user data is not used for advertising and is
  not sold or transferred to data brokers or information resellers.
- **Human access** is limited to the security, abuse, legal-compliance, and
  explicit-user-consent cases the Limited Use policy allows.
- **Compliance statement.** The use of information received from Google APIs
  by New Coworker adheres to the Google API Services User Data Policy,
  including the Limited Use requirements.

Please let us know if anything else is needed; the test account and video
will remain available for the duration of the review.

Best regards,
Brian Lane
Founder, New Coworker (Newcoworker LLC)
team@newcoworker.com
