---
name: project-admin-mfa-factor-load
description: auth-js data.totp is verified-only; the admin MFA "no factor available" message is a symptom, not a cause; how to date an auth incident with no audit log
metadata:
  type: project
---

Aug 30 2026, /admin/mfa said "No authenticator factor is available." while the
verified TOTP factor sat untouched in the database. Fixed in PR #1757.

**auth-js files ONLY verified factors under `listFactors().data.totp`.** In its
`_listFactors`, the `data[factor.factor_type].push` sits inside an
`if (factor.status === 'verified')`. Unverified factors appear in `data.all`
and nowhere else. Any code filtering `data.totp` for unverified rows is dead.
Confirmed by reading node_modules in 2.112.2 and 2.112.3.

**`listFactors()` is one `GET /auth/v1/user`.** A single dropped request on a
phone left the page with no factor, and the submit handler's `setError("")`
then wiped the real load error and replaced it with the generic message. The
generic message describes empty form state, never a cause.

**Dating an auth incident on this project, which has NO audit log.**
`auth.audit_log_entries` is empty (0 rows, all time), so do not reach for it.
Use instead:
- `auth.mfa_challenges` proves whether a verify attempt reached the server at
  all. No row means it died client-side.
- `auth.sessions` + `auth.refresh_tokens` give the minute-by-minute timeline,
  including `aal` and which session got upgraded.
- `auth.mfa_factors.updated_at` is stamped by a successful verify.
- A session that survives a page reload RULES OUT `AuthSessionMissingError`:
  that path calls `_removeSession()`, which clears the cookie and would force
  a fresh login and a new session row.

Reach the DB with the IPv4 session pooler, see
[[project_supabase_ipv6_direct_host]]. The PWA service worker caches nothing
and only intercepts navigations, so it is never the stale-bundle culprit, see
[[project_push_pwa_channel]].
