# CASA AL1 SAQ: the 54 answers as submitted

**Submitted:** 2026-08-01 · **Accepted by TAC:** *"the Self-Assessment
Questionnaire submitted by your team meets all the requirements."*
**Result:** 49 Yes, 5 No. The five No answers did **not** block the Letter of
Validation.

Committed because this text was staged in `/tmp` twice during the 2026 cycle
and lost both times, and because the portal form holds answers only in the
browser until submitted. Start the reassessment from this file, not from
memory. Two 2026 answers were written from memory and were **wrong** (see the
warning below); `debug/casa-posture-probe.ts` exists to stop that recurring.

> **Re-verify before reusing.** Run `tsx debug/casa-posture-probe.ts` first. It
> mechanically re-proves the externally observable claims (CORS, HSTS, baseline
> headers, source disclosure, security.txt, live password minimum) and prints a
> dated report. Anything it fails is an answer that has drifted.

## The five No answers, and why they were accepted

| # | Gap | Status at 2026 submission |
| --- | --- | --- |
| 10 | Uploads not antivirus scanned | Compensating: MIME allowlist (text/PDF/DOCX), 10 MB cap, private bucket, parsed as data |
| 16 | Dashboard-managed host and CDN config has no tamper attestation | Repo config is drift-checked; provider dashboards are not attestable |
| 47 | Key material readable by the app, not in an HSM or KMS | Architectural; AES-256-GCM with keys from restricted platform config |
| 52 | No audit trail of read access to personal data | Mutations and coworker actions are logged; read auditing needs its own design |
| 54 | OCSP stapling not enabled | **Not actionable.** The issuing CA retired OCSP for CRLs, so there is nothing to staple |

## What was corrected mid-cycle, and the lesson

- **#19** originally claimed password policy was wholly delegated to Supabase. False: `src/lib/password.ts` already enforced a policy. Corrected, and the minimum was raised to 12 in both layers (PR #1103).
- **#24** asserted an OTP lifetime that had **never been read**. Corrected after the setting was confirmed at 600 seconds.

Both were caught only because someone re-checked. Attesting to an unread value is the failure mode this whole file guards against.

---

## Answers

| # | Requirement (abbreviated) | Answer | Comment as submitted |
| --- | --- | --- | --- |
| 1 | Trust boundaries, components, data flows documented | Yes | Documented in the repository README (Architecture, Security posture, per-VPS isolation, per-tenant gateway tokens) and in `google-oauth-assets/casa/`. Boundaries: browser, Vercel-hosted application, Supabase (Auth, PostgreSQL, Storage), the Cloudflare edge, the per-tenant VPS fleet, and brokered third parties (Nango, Stripe, Telnyx). |
| 2 | No deprecated client-side tech | Yes | React and Next.js only. No NSAPI plugins, Flash, Shockwave, ActiveX, Silverlight, NACL or Java applets. Verified against production HTML; CSP sets `object-src 'none'`. |
| 3 | Access control on trusted enforcement points | Yes | Server side only: `requireAuth`, `requireBusinessRole`, `requireOwner`, `requireAdmin` in `src/lib/auth.ts`, route gating in `src/proxy.ts`, and PostgreSQL row-level security as an independent second layer. No client-side check is authoritative. |
| 4 | Sensitive data identified and classified | Yes | Categories enumerated in the published privacy policy and reflected in distinct storage mechanisms by sensitivity: AES-256-GCM envelopes for integration secrets, SHA-256 hashes for public API keys, private Storage buckets for uploaded documents, RLS-scoped rows for tenant data. |
| 5 | Protection requirements per level, applied in architecture | Yes | Each level carries its handling rule: encryption at rest, authenticated-ciphertext envelopes for secrets, irreversible hashing for API keys, retention and deletion published in the privacy policy and at `/privacy/data-deletion`. |
| 6 | Integrity protections; no untrusted code loaded | Yes | Loads no third-party script or stylesheet at all; production HTML references only same-origin `/_next/static` assets. CSP sets `object-src 'none'` and `base-uri 'self'`. Dependencies lockfile-pinned and audited in CI on every push. |
| 7 | Subdomain takeover protection | Yes | Per-tenant Cloudflare tunnels and hostnames are provisioned and torn down with the tenant; a daily posture pass reports untracked machines and boxless tenants. DNS and subdomain inventory provided as evidence. |
| 8 | Anti-automation controls | Yes | Cloudflare bot management, per-IP limiting in `src/proxy.ts`, a PostgreSQL-backed cross-instance limiter for unauthenticated cost-amplifying endpoints, tier caps, and a 10 MB MIME-allowlisted upload path. |
| 9 | Untrusted files stored outside the web root | Yes | Private Supabase Storage bucket (`src/lib/documents/core.ts`), never the web root, retrieved only through authorized record-scoped handlers. |
| **10** | Uploads antivirus scanned | **No** | Not scanned by an antivirus engine. Compensating: MIME allowlist limited to text, PDF and DOCX (`src/lib/documents/ingest.ts`), 10 MB cap, private bucket outside the web root, parsed as data rather than executed. |
| 11 | API URLs do not expose secrets | Yes | No API key or session token appears in a URL; sessions in HttpOnly cookies, API keys in headers and stored as SHA-256 hashes. Disclosed: emailed capability links carry a single-purpose, business-scoped, expiring token as a query parameter, inherent to a click-through link. |
| 12 | Authorization at URI and resource level | Yes | Both: `src/proxy.ts` gates by route, each handler re-checks business membership and role server side, and row-level security enforces at the record level. |
| 13 | RESTful methods restricted | Yes | Route handlers export only the verbs they implement, so unimplemented methods return 405. Verified in production. |
| 14 | Secure repeatable build and deploy | Yes | CI runs tests, typecheck, lint, CodeQL and dependency audit per pull request. Merging to main applies migrations, deploys edge functions and deploys the application, each step blocking the next. |
| 15 | Redeployable from scripts, runbook, backups | Yes | Redeploys from main with no manual steps. Migrations versioned in `supabase/migrations` and applied by CI with drift detection. VPS fleet reprovisioned from scripts. Runbook in the repository README. |
| **16** | Admins can verify integrity of security config | **No** | Repository config is reviewable in version control and drift-checked against the live database schema, but dashboard-managed settings at the hosting and CDN providers carry no tamper detection or attestation. |
| 17 | Debug modes disabled in production | Yes | Optimized production build, no debug flags, no developer console. Error responses generic, exposing neither stack traces nor framework internals. |
| 18 | Origin header not used for authz | Yes | Origin and Referer used solely for CSRF validation of cookie-authenticated state-changing requests in `src/proxy.ts`, never as a source of identity or authorization. |
| 19 | User passwords at least 12 characters | Yes | Enforced at two layers. Supabase Auth configured with a minimum length of 12 and complexity of lowercase, uppercase, digits and symbols; verified live, where a shorter password is refused with "Password should be at least 12 characters". The application applies the same rules via a shared validator (`src/lib/password.ts`) whose symbol set mirrors Supabase character for character. Binds newly set and changed passwords; existing shorter passwords are not retroactively invalidated. |
| 20 | System-generated initial secrets random, short-lived | Yes | Initial and recovery secrets generated by Supabase Auth, time limited and single use, and cannot become a long-term password. Provisioned test accounts have their password re-minted per use and it is never stored in the repository. |
| 21 | Passwords salted and hashed with approved KDF | Yes | The application never stores or hashes passwords. Supabase Auth stores and verifies them using a salted, approved one-way key derivation function. |
| 22 | No shared or default accounts | Yes | No shared, default or vendor accounts. No root, admin or sa account. Administrative access is an explicit email allowlist bound to a real authenticated identity and additionally requires AAL2. |
| 23 | Lookup secrets single use | Yes | Recovery and magic-link verifiers are generated and invalidated after a single use by Supabase Auth. |
| 24 | Out-of-band verifier expires within 10 minutes | Yes | Email one-time codes and magic links expire after 600 seconds. Configured in Supabase Auth as the Email OTP expiration and confirmed 2026-08-01. Generation, expiry and single use are controlled by Supabase Auth rather than application code. |
| 25 | Initial auth code from secure RNG, 20+ bits | Yes | Generated by Supabase Auth using a cryptographically secure random number generator, well above 20 bits of entropy. |
| 26 | Logout and expiry invalidate the session | Yes | Sign-out invalidates server side via Supabase `signOut`, and confidential browser storage is cleared on logout (`src/lib/auth/clear-confidential-storage.ts`). Access tokens carry an enforced expiry, so the back button cannot resume an ended session. |
| 27 | Option to terminate other sessions after password change | Yes | Implemented in `src/lib/auth/terminate-other-sessions.ts`, invoked from both the password change and password reset paths. |
| 28 | Session tokens rather than static keys | Yes | Human sessions use short-lived Supabase JWTs. The only long-lived credentials are owner-created public API keys for a documented integration surface, stored solely as SHA-256 hashes (`src/lib/public-api/keys.ts`). |
| 29 | Full session or re-auth before sensitive actions | Yes | Sensitive changes require a valid session and server-side role checks. Administrative surfaces additionally require AAL2, and email changes require provider confirmation. |
| 30 | Access control on a trusted service layer | Yes | Entirely server side, with row-level security as an independent layer that still holds if an application check were bypassed. |
| 31 | Policy attributes not user-manipulable | Yes | Roles and business membership resolved server side from the authenticated identity and the database. Clients cannot submit or influence their own authorization attributes. |
| 32 | Least privilege | Yes | Scoped to the authenticated user's business membership and role, public API keys scoped to a single business, features additionally tier gated. |
| 33 | Access controls fail securely | Yes | Missing identity, membership or role fails closed with 401 or 403. Secret decryption and tenant-bound token validation failures also fail closed with a generic error. |
| 34 | IDOR protection | Yes | Every user-supplied business or record identifier is checked against server-side membership before use, and row-level security independently constrains the visible row set. OAuth state binds callbacks to a business and session. |
| 35 | Admin interfaces use MFA | Yes | `/admin` requires the administrator allowlist identity plus a token asserting `aal2`; AAL1 administrators are redirected to enrol. Implemented in `src/lib/auth/admin-aal.ts`, enforced in `src/proxy.ts` and `requireAdmin`. |
| 36 | HTTP parameter pollution defenses | Yes | Parameters read through the WHATWG URL API, which resolves duplicate keys deterministically to the first value, and every handler validates inputs against an explicit schema. |
| 37 | Mail input sanitized (SMTP/IMAP injection) | Yes | Outbound mail sent through a provider API with structured recipient, subject and body fields rather than raw SMTP header concatenation, so header injection is not reachable. Inbound HTML sanitized at display. |
| 38 | No eval or dynamic code execution | Yes | Verified: no `eval()` and no `new Function()` appears anywhere in the application source. |
| 39 | SSRF protections | Yes | User-supplied URLs validated before fetch: localhost, `.localhost` and `.internal` rejected, resolved addresses checked against private and reserved ranges (`src/lib/net/ip-classification`, used by `src/lib/website-ingest.ts`). |
| 40 | SVG scriptable content sanitized | Yes | SVG is not an accepted upload type; the allowlist is text, PDF and DOCX only, so scriptable SVG is never stored or served. |
| 41 | Context-appropriate output encoding | Yes | React escapes interpolated values contextually by default; untrusted HTML is not injected into the DOM. Database access is parameterized. |
| 42 | JSON injection protections | Yes | JSON parsed with `JSON.parse` and validated against explicit schemas. No dynamic evaluation of JSON or user expressions. |
| 43 | LDAP injection protections | Yes | No LDAP directory is used or queried; identity is Supabase Auth over PostgreSQL, so LDAP injection is not reachable. |
| 44 | Regulated data encrypted at rest | Yes | Supabase PostgreSQL and Storage encrypt at rest at the platform level; high-sensitivity integration secrets additionally wrapped in AES-256-GCM with unique 96-bit IVs and authenticated ciphertext. |
| 45 | Constant-time crypto operations | Yes | Secret and token comparisons use a constant-time comparator (`src/lib/timing-safe-utf8.ts`, wrapping node crypto `timingSafeEqual`). Primitives delegated to the platform, not hand rolled. |
| 46 | GUIDs from CSPRNG v4 | Yes | Identifiers generated with node crypto `randomUUID`, version 4, CSPRNG backed. |
| **47** | Key material isolated in a vault | **No** | Held in restricted platform environment configuration rather than an HSM or KMS, so the application process can read it. Envelopes use AES-256-GCM with a key from that configuration. |
| 48 | No credentials or payment details in logs | Yes | The logger scrubs context before serialization, replacing credential-bearing keys with a redaction marker including nested structures (`src/lib/log-redaction.ts`). Card data goes directly to the hosted checkout. Disclosed limitation: key-based matching, so a secret interpolated into a free-text message survives. |
| 49 | Sensitive data protected from caching | Yes | Authenticated responses are dynamically rendered and not publicly cacheable; only public marketing and machine-readable files carry public cache-control. |
| 50 | Browser storage free of sensitive data | Yes | No auth material in localStorage or sessionStorage. Unfinished onboarding data cleared on logout (`src/lib/auth/clear-confidential-storage.ts`); what remains is non-confidential UI preference. |
| 51 | Sensitive data in body or headers, not query strings | Yes | Credentials and API keys travel in the request body or headers, never the query string. Same emailed-capability-link disclosure as #11. |
| **52** | Read access to sensitive data audited | **No** | Mutations and coworker actions are recorded to an application log, but there is no comprehensive audit trail of read access to personal data. |
| 53 | Trusted TLS certificates | Yes | TLS terminates at the CDN edge with a publicly trusted certificate (Let's Encrypt); verified externally with a clean chain. No self-signed certificates trusted. Minimum TLS 1.2; 1.0 and 1.1 refused. |
| **54** | Certificate revocation (OCSP stapling) | **No** | OCSP stapling not enabled; verified externally, the server sends no stapled response. The issuing certificate authority has retired OCSP in favour of certificate revocation lists and short-lived certificates, so there is no response available to staple. Revocation relies on CRL distribution and short lifetimes. |
