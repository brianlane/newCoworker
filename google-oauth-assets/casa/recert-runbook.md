# CASA annual reassessment runbook

Google requires recertification **annually**. The 2026 cycle completed
2026-08-05, so the next one is due around **August 2027**.

**Start in June 2027, not August.** The 2026 assessment took roughly a week of
back-and-forth *after* the scan completed, and that was with everything already
remediated. The deadline Google gives is a hard stop, not a target.

Everything below was learned the expensive way in 2026. Read it before touching
the portal.

---

## Before you contact anyone

Run the posture probe. It re-proves the externally observable SAQ claims and
prints a dated report you can attach:

```bash
tsx debug/casa-posture-probe.ts
```

Anything it fails is an SAQ answer that has drifted since last year. Fix it
before submitting, rather than restating an answer that is no longer true. An
overclaimed control is what gets a Letter of Validation pulled after issuance.

Then re-read [`saq-answers.md`](saq-answers.md), which holds all 54 answers as
submitted and accepted, and [`dast-triage.md`](dast-triage.md), which holds the
per-finding dispositions with first-hand evidence.

Not covered by the probe, so check by hand:

- **Qualys SSL Labs** report for `www.newcoworker.com`. B or better passes; we scored A after setting Minimum TLS to 1.2 at the CDN.
- **Supabase → Database → Backups**, for the "restorable from backups" half of SAQ 15.
- **Supabase → Authentication → Sign In / Providers → Email**, which shows the password minimum, the complexity requirement and the OTP expiry in a single frame. That one screenshot evidences SAQ 19 and 20 together.

---

## The sequence

1. **Google emails you** that a reassessment is due, naming the deadline and the authorized lab. Reply to that thread to begin.
2. **Lab portal**: submit application details, schedule the DAST scan.
3. **Report generated**, then **remediation**: dispute false positives, fix what is real.
4. **Revalidate**: request the rescan, which must come back clean.
5. **SAQ**: 54 questions, submitted through the portal.
6. **Encryption evidence**: they will ask whether you store Google user data, for the algorithms, and for a screenshot of encrypted data at rest.
7. **LOV**: the lab submits the Letter of Validation.
8. **Reply to Google's Trust and Safety thread.** See the warning below.

---

## Traps

### Google does not notice that CASA finished

The Verification Center keeps showing the CASA item until **you reply on the
Trust and Safety email thread**. The page says so explicitly: *"The Trust and
Safety team will continue the verification process once all issues are
resolved."* In 2026 the assessment was complete and the LOV submitted while
Google's checklist still read "last reviewed Jul 29". Nothing advances until
you send that email.

### Verify CORS headers with an `Origin` header, always

The single most expensive lesson of 2026. Vercel's static serving replaces our
`Access-Control-Allow-Origin` with `*` **only when the request carries an
`Origin` header**. A plain `curl` shows the correct value and looks fixed.

```bash
# Useless for this purpose:
curl -sSI https://www.newcoworker.com/robots.txt | grep -i access-control

# What a scanner actually does:
curl -sSI -H "Origin: https://example.invalid" https://www.newcoworker.com/robots.txt | grep -i access-control
```

This cost two extra pull requests and one wasted CDN cache purge before the
cause was found. The probe now always sends an Origin.

`force-static` routes and files in `public/` are affected; `force-dynamic`
routes are not. `/robots.txt` was made dynamic and `/logo.png` is served
through a `beforeFiles` rewrite for exactly this reason.

### Portal mechanics

- **The SAQ URL only works with the scan id percent-encoded.** A hand-built URL ending in a raw `=` silently redirects to the scan list. Take the href from the "View SAQ Detail" action instead of typing it.
- **Scan ids are re-keyed when the portal updates.** An id recorded earlier will 404 with "You are not permitted to perform this action!" Re-read links from `/scan-list/index`.
- **The SAQ form holds answers only in the browser until submitted.** Navigating away loses all 54. Repopulate from `saq-answers.md` and verify the form is loaded and filled immediately before clicking Submit.
- **The Revalidate control fires a native `confirm()`.** Headless and agent browsers suppress native dialogs, so clicking it appears to do nothing. Its handler submits `#revalidation-form` after confirmation.
- **Revalidations are a limited allowance** (the tooltip showed "(2)"). Check the row state before re-clicking rather than assuming the first click failed.

### Finding dispositions

The lab will grant exceptions for well-evidenced false positives and
third-party dependencies, but you have to make the case. In 2026 all 14
findings were closed: 8 info excepted outright, then 5 more on written
evidence, and only 1 required an actual code change.

Reproduce every finding first-hand before disputing it. The scanner's own
evidence URL is usually the argument: the "NoSQL injection" was a query
parameter appended to a **static JS chunk**, and the "source code disclosure"
was the **image optimizer** returning a PNG, on a similarity heuristic that
crossed its threshold by one percentage point.

### The lab's own portal is not the source of truth for Google

The portal marking "LOV Submitted" does not mean Google has seen it. Confirm
against the Google Cloud Console Verification Center, and ask the lab for a
copy of the LOV for your records.

### The OAuth client can be deleted for inactivity, and that would take the verification with it

The client page carries a "Last used date" and this warning: "Inactive OAuth
clients are subject to deletion if they are not used for 6 months. You will be
notified of deletion due to inactivity, and can restore clients up to 30 days
after deletion."

On 2026-08-11 it read **July 30, 2026**, while the fleet was polling Gmail
every minute for three connected accounts. So token refreshes appear NOT to
count as use: only authorizations do. The last real tenant connect was Jul 22.

With few Google connections and few new ones, a six-month gap with zero
authorizations is not far-fetched, and losing the client would take the
verification with it. That is the same class of outage as letting CASA lapse:
every tenant with a connected Gmail breaks, and it is not a paperwork problem.

**Check the Last used date when this runbook is opened each June.** If it is
approaching six months, a single re-consent on the internal sandbox tenant
resets it.

---

## Contacts and identifiers

| Field | Value |
| --- | --- |
| GCP project | `new-coworker`, project number 354099628168 |
| Assessed application | https://www.newcoworker.com |
| Tier | 2 (ADA-CASA AL1) |
| Application type | Web |
| Lab (2026) | TAC Security, portal at `casa.tacsecurity.com`, `casasupport@tacsecurity.com` |
| Scopes requiring verification | `gmail.modify` (restricted), `calendar.events` (sensitive) |

Non-sensitive and identity scopes (`calendar.app.created`,
`calendar.events.freebusy`, `openid`, `userinfo.email`, `userinfo.profile`) do
not require verification and will not appear in the approval email.

**Any new sensitive or restricted scope, or any change to the OAuth consent
screen configuration, requires a fresh verification request.** Verification
cannot be inherited.

The scope set is now also frozen in code at
`src/lib/google/workspace-scopes.ts`, and `tests/google-workspace-scopes.test.ts`
fails CI if it changes, quoting the rule above. Update both together, and only
with a verification step in hand.

### OAuth client inventory

One client serves three consumers, which is the main hazard when editing it:
Supabase Auth "Log in with Google", our first-party workspace OAuth, and (until
its rows finish migrating) the Nango broker. A careless edit breaks **site
login**, not just integrations.

| Field | Value |
| --- | --- |
| Client | `354099628168-j492f9g632aaoa6p851gojcq5g4rhu58.apps.googleusercontent.com`, created Apr 2 2026 |
| Authorized redirect URIs | `https://www.newcoworker.com/api/auth/callback/google` (first-party), `https://api.nango.dev/oauth/callback` (broker), `https://glwmorjxzkzpcfffwvkk.supabase.co/auth/v1/callback` (Supabase sign-in) |
| Authorized JavaScript origins | none |
| Client secret | Not viewable in the console ("Viewing and downloading client secrets is no longer available"). The value is held in Vercel, in the Supabase Auth Google provider config, and in the Nango integration config. |

**Authorized domains are DERIVED from the redirect URI list**, which the console
states explicitly. That is what makes the two cases different:

- **Adding** a redirect URI under a domain already present is client config, and
  is safe. This is how the first-party callback shipped with no console change.
- **Removing** `https://api.nango.dev/oauth/callback` drops `nango.dev` out of
  authorized domains, which IS a consent-screen change. Do it inside a
  recertification window, when a re-review costs nothing extra, rather than
  opportunistically after the last Google row goes direct.

**Rotating the secret** is supported without downtime: add a second secret, set
it everywhere it is consumed (Vercel AND the Supabase Auth provider config),
verify both `/login` and a workspace connect, then delete the old one. Rotation
is credential config, not a consent-screen change, so it does not affect
verification. Do it on its own, on a day nothing else is shipping, because it is
the one change that can break login for everyone.
