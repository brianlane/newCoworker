# Google OAuth verification: reply to the Trust and Safety email

Paste the text below (after filling the two placeholders) as a direct reply
on the "[Action Needed] OAuth Verification Request Acknowledgement" thread
for project `new-coworker`. Placeholders:

- `[REVIEWER_PASSWORD]`: mint with `tsx debug/google-reviewer-setup.ts --apply`
  right before sending (the credential is never stored in this repo).
- Demo video (recorded Jul 27, unlisted): https://youtu.be/un8DqDUi26Q

Keep the same video link and credentials in the Verification Center
submission so the two channels never disagree.

Scope-set note (Jul 26, 2026): the public self-serve booking page shipped
after the first submission and deliberately re-added the two NON-sensitive
granular calendar scopes (`calendar.events.freebusy`,
`calendar.app.created`) so most calendar work rides least-privilege scopes.
The declared set below is final; do not trim it back to the Jul 24 two-scope
set.

---

Hello,

Thank you for the review. We have addressed each item below for project
`new-coworker` (single OAuth web client `354099628168-j492f9g632aa...`).

## 1. Scope alignment (discrepancy resolved)

We audited the authorization request against the console configuration:
the client now requests exactly the scopes declared in Data Access, nothing
more. `gmail.settings.basic` was REMOVED rather than justified (no feature
ever called a Gmail settings endpoint). The declared set:

- `https://www.googleapis.com/auth/calendar.events.freebusy` (non-sensitive)
- `https://www.googleapis.com/auth/calendar.app.created` (non-sensitive)
- `https://www.googleapis.com/auth/calendar.events` (sensitive)
- `https://www.googleapis.com/auth/gmail.modify` (restricted)
- `openid`, `userinfo.email`, `userinfo.profile` (sign-in identity; this
  same client also powers "Log in with Google" at
  https://www.newcoworker.com/login, which requests the identity scopes
  only)

## 2. Scope justifications (feature to scope)

New Coworker (https://www.newcoworker.com) is an AI coworker for small
businesses. Only the business OWNER connects their Google account (Dashboard
-> Integrations); customers of the business never grant access.

Our three calendar scopes are split by least privilege:

**calendar.events.freebusy.** Availability reads ONLY. The AI coworker and
the business's public self-serve booking page (`/book/<token>`) compute open
slots from the owner's free/busy data (`freeBusy` query). Visitors see
coarse open slot starts, never event data.

**calendar.app.created.** The app creates ONE secondary "NewCoworker"
booking calendar on the owner's account and writes there: new bookings land
on it (so the whole team can subscribe to it), and employee time-off is
mirrored onto it as all-day display events. This scope grants access only
to calendars the app itself created.

**calendar.events.** Required for what the two narrower scopes cannot do:
rescheduling and canceling appointments that live on the owner's OWN
calendars (bookings made before the app calendar existed, and owner-created
events the owner asks the AI coworker to move or cancel), booking fallback
to the primary calendar when the app calendar cannot be created, and
calendar-based automations that read event details from the owner's
calendars to run the owner's configured workflows (free/busy exposes no
event details, and app.created cannot read or write the owner's own
calendars).

**gmail.modify.** The owner points automations at their business inbox;
when a customer email arrives, the AI coworker reads it (messages.list /
messages.get), sends the reply FROM the owner's own Gmail address so the
customer sees the business address (messages.send), marks the original
message read (messages.modify, removing UNREAD) when a flow answers it, and
applies the owner's authored organization (labels, archive by removing
INBOX, folder-style user labels) when an AiFlow `email_organize` step runs.
`gmail.readonly` cannot send or mark handled; `gmail.send` cannot read the
inbound email or update labels; combining them still cannot update message
state. `gmail.modify` is the single narrowest scope covering read + send +
label/state update, and we use no other Gmail surface (no settings, no
deletion, no full mailbox access via mail.google.com).

## 3. Test credentials (no authentication blockers)

Reviewer account on our production environment, which authorizes through the
production client above:

- URL: https://www.newcoworker.com/login
- Email: google.reviewer@newcoworker.com
- Password: [REVIEWER_PASSWORD]

The account has no 2FA, no phone verification, and no CAPTCHA on login. It
owns a pre-configured sandbox business with the Integrations page, the
public booking page, and an enabled email-triggered flow. A step-by-step
walkthrough covering the grant, each scope in use, and removal is published
at: https://www.newcoworker.com/integrations/google/review-test-plan

## 4. Demo video

Updated demo video (unlisted): https://youtu.be/un8DqDUi26Q

It shows, in order and without cuts around the consent screen: the app
context; sign-in with Google on the same client (identity scopes only); the
full OAuth grant from Dashboard -> Integrations with the browser URL bar
visible (client id identifiable) and the complete consent screen; the
calendar scopes in use (AI booking by chat landing on the app-created
NewCoworker calendar, a reschedule of an appointment on the owner's own
calendar shown in Google Calendar, and the public booking page computing
open slots from free/busy); and `gmail.modify` in use (inbound customer
email read by the AI coworker, the reply visible in the owner's Gmail Sent
folder, and the original message marked read), ending with disconnect
availability.

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
