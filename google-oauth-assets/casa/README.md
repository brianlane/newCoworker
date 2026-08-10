# ADA-CASA AL1 assessment

Everything for the CASA security assessment that Google requires because the
OAuth app requests the restricted `gmail.modify` scope. This directory is the
working record; the reviewer-facing material for the OAuth verification itself
lives one level up in [`google-oauth-assets/`](../).

## Why this is the critical path

Google's Verification Center for GCP project `new-coworker` (project number
354099628168) showed six of seven requirements **passed** as of July 29, 2026:
homepage, privacy policy, app functionality, branding, appropriate data access,
and request minimum scopes. The only failing item is:

> Additional requirements: You are required to complete a CASA security
> assessment for your app.

So CASA is the single remaining blocker on verification. **Deadline
October 27, 2026**, with an internal target of a Letter of Validation (LOV) by
mid-September.

## Lab and assessment identifiers

| Field | Value |
| --- | --- |
| Assessment | ADA-CASA **AL1** (formerly Tier 2), self-assessment plus lab-validated scan |
| Authorized lab | TAC Security, ESOF portal at `casa.tacsecurity.com` |
| GCP project | `new-coworker`, project number 354099628168 |
| Assessed application | `https://www.newcoworker.com` |
| Restricted scope driving the requirement | `gmail.modify` |
| Scan | `New Coworker production DAST 2026-07-30`, PO_21824_1785445496 |
| Support ticket | 1785446592 |

## Status

| Portal step | State |
| --- | --- |
| 1. Submit LOV details | Complete |
| 2. Scan your app | Complete |
| 3. Report generated | Complete |
| 4. Remediation | In progress |
| 5. Revalidate | Pending |
| 6. LOV submitted | Pending |

## Scan outcome

**14 findings: 0 critical, 0 high, 2 medium, 4 low, 8 info. No finding
requires an application code fix.** Every finding was reproduced first-hand
against production rather than taken from the scanner summary, and both
mediums are false positives with reproducible evidence. See
[`dast-triage.md`](dast-triage.md) for the per-finding disposition and the
evidence behind each one.

Two caveats recorded there and worth repeating:

- The scan ran **through Cloudflare bot management**, which challenged
  non-browser clients. An unknown share of the application was therefore
  challenged rather than actually tested, and TAC should be told that plainly
  rather than left to infer clean coverage.
- The scan was **unauthenticated**, so the SAQ controls that ADA marks
  lab-verified are answered from code review with file-level citations. That
  is a deliberate, recorded decision, not an oversight.

## Reassessment

CASA recertification is **annual**. Start in June, not August.

- **[`recert-runbook.md`](recert-runbook.md)**: the sequence, the portal traps, and the identifiers. Read before touching the lab portal.
- **[`saq-answers.md`](saq-answers.md)**: all 54 answers as submitted and accepted, so the next cycle starts from the real text rather than reconstruction.
- **`tsx debug/casa-posture-probe.ts`**: re-proves the externally observable SAQ claims against production and prints a dated report to attach.

## Policies

Written from this system's actual architecture rather than adapted from a
generic template, including their limitations:

- [`policies/incident-response.md`](policies/incident-response.md)

The vulnerability disclosure channel is published rather than filed: see
`/.well-known/security.txt` (RFC 9116) and
`/security/vulnerability-disclosure`.

## What CASA remediation has already shipped

| PR | Control | Change |
| --- | --- | --- |
| #1031 | 3.3.1, 2.2.2, 6.6.1 | Admin MFA (AAL2), other sessions terminated on password change, confidential browser storage cleared on logout |
| #1065 | 6.5.1 | Log context is scrubbed of secrets in `src/lib/logger.ts` rather than trusting call sites |
| #1071 | 5.1.7 (measurement only) | Strict `Content-Security-Policy-Report-Only` plus a hard-capped report sink |

**The older SAQ working draft still lists 2.2.2, 3.3.1 and 6.6.1 as
REMEDIATE. That is stale: #1031 fixed all three.**

## What is deliberately not claimed

An overclaimed control is what gets an LOV pulled later, so these stay "no"
until they are actually true:

- **5.1.7, full script-src CSP.** #1071 ships Report-Only only. Enforcement
  needs per-request nonces, which conflict with the deliberately
  `force-static` marketing pages.
- **Auth rate limiting as an application control.** Login calls
  `supabase.auth.signInWithPassword` client-side, so credentials go from the
  browser straight to Supabase and never traverse `src/proxy.ts`. Supabase
  Auth's own limits are the real control, and the SAQ says so.
- **Encryption at rest for every server-side secret.** Per-tenant VPS gateway
  tokens are stored as restricted configuration by design.
- **Automatic redaction of free-text log messages.** #1065 matches on keys, so
  a secret a caller interpolates into `error.message` still survives.
