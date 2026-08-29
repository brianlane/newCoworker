---
name: google-chat-needs-workspace-account
description: "Google Chat cannot ship to customers from newcoworkerteam@gmail.com: a personal Google account hard-disables 'Join spaces', locks visibility to the owner's own address, and forces the Workspace add-on shape. Credential and env vars ARE done."
metadata:
  type: project
---

Established 2026-08-28 while finishing the Google Chat owner channel
(shipped in #1724, see [[coworker-channel-architecture]]).

**The wall.** `newcoworkerteam@gmail.com` is a consumer account.
`gcloud organizations list` returns 0 items, and `newcoworker.com` mail runs
on Cloudflare Email Routing, not Workspace (see
[[email-routing-catchall-is-the-product]]) - `team@newcoworker.com` is a Gmail
send-as alias, not a Workspace mailbox. So there is no second Google account
to switch to.

On the Chat API Configuration page Google prints:
"Users with personal Google accounts can only create apps for personal use.
Settings such as 'Join spaces and group conversations' are disabled
automatically." Three controls carry `aria-disabled="true"` plus
`mdc-checkbox--disabled`, verified after full hydration on two page loads:

1. **"Join spaces and group conversations" - locked OFF.** This is the one
   that matters. Our design binds a SPACE (`spaces/{id}`, see
   `isSpaceName` and `handleGoogleChatEvent`), so a DM to Brian is the only
   conversation the app can ever have.
2. **Visibility - locked to `newcoworkerteam@gmail.com`**, with no domain to
   widen it to.
3. **"Build this Chat app as a Workspace add-on" - locked ON**, and clearing
   it is documented as unrevertable anyway.

Read the Material classes after hydration, not before: a half-hydrated page
reports these inconsistently, and `mat-mdc-radio-disabled-interactive` on the
Marketplace page means "greyed but usable", NOT disabled.

**Marketplace.** A consumer account can only publish PUBLIC (Private is
Workspace-org only), which means Google's full review: 32/48/96/128 icons, a
220x140 card banner, screenshots, ToS + privacy + support URLs, category,
pricing, trader status. The App Visibility choice is permanent once saved.
None of that lifts the "Join spaces" lock, which is scoped to the ACCOUNT.

**What is already done and does not need redoing** (project `new-coworker`,
number 354099628168):

- Service account `newcoworker-chat@new-coworker.iam.gserviceaccount.com`,
  JSON key minted and verified: it mints a real `chat.bot` access token
  through the same RFC 7523 flow `fetchGoogleAccessToken` runs. No IAM role
  is needed; Chat authorizes it because it lives in the app's own project.
- Vercel PRODUCTION `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY` and
  `GOOGLE_CHAT_AUDIENCE` (=354099628168), both `--sensitive`. Sensitive vars
  are WRITE-ONLY: `vercel env pull` returns `[SENSITIVE]`, so verify the
  credential against Google instead of reading it back.
- Chat app config saved and confirmed across a reload: name "New Coworker",
  avatar `https://www.newcoworker.com/logo-512.png` (live, 512x512), one
  endpoint for every trigger at
  `https://www.newcoworker.com/api/webhooks/google-chat`, error logging on.
- `appsmarket-component.googleapis.com` enabled.

**The audience trap, CLOSED by PR #1730.** The "Authentication Audience"
setting does not appear anywhere on this add-on-shaped config page (the word
"audience" is absent from the DOM) and no API reports it, so which mode is
active could not be read off. Worse than a single wrong constant: the two
settings send DIFFERENT KINDS OF TOKEN.

  project number -> a JWT Chat self-signs as chat@system.gserviceaccount.com,
                    verified against that account's key set (5 keys)
  app URL        -> an OpenID Connect ID token from accounts.google.com,
                    verified against Google's federated certs (4 keys)

The key sets are DISJOINT. The tell is in Google's own samples: the
project-number one points the verifier at the Chat service account's
certificates, the app-URL one uses GoogleIdTokenVerifier with its default
key source, which only works for the federated issuer. The doc line saying
the issuer is "always chat@system.gserviceaccount.com" describes the
project-number mode only. Bugbot caught this; my first pass widened the
audience and left the issuer pinned, which would still have 401'd every
event.

**And the ID-token shape is NOT safe on signature plus audience.**
`accounts.google.com` signs for every account Google hosts, and the audience
of an ID token is chosen by whoever requests one, so any service account
anywhere can have Google mint a correctly signed token whose `aud` is our
webhook URL. What identifies Chat in that mode is the `email` claim, pinned
to chat@system.gserviceaccount.com with `email_verified` required. Never
widen an issuer to a shared one without a claim check underneath it.

`GOOGLE_CHAT_AUDIENCE` now takes a comma-separated list and both token
shapes verify, so the mode no longer has to be known in advance.

**The route chosen (2026-08-29).** Brian opted to take DM-only seriously
rather than buy Workspace. A published app would be direct-message only: an
owner can DM the coworker and get alerts back, no shared team space. The
product needs NO code change for this - the integration card already says
"or start a direct message with it" and `handleGoogleChatEvent` already
notes "a DM has only `text`". A DM is a space (`spaces/XXXX`), so the
connect-code binding works unchanged. Marketplace listing assets (32/48/96/128
icons plus a 220x140 banner) were generated from `public/logo-512.png`;
support URLs are /terms, /privacy and /contact (there is no /support or
/help). Still not done, and both are ONE-WAY: saving App Visibility as
Public, and SUBMIT FOR REVIEW.

**Nothing is broken meanwhile.** Every Google Chat path fails closed:
`POST /api/webhooks/google-chat` answers 401 today and dispatch records no
notification row for a business that never connected.
