---
name: audit-allowlist-mechanism
description: The Security Audit CI runs npm audit through an expiring per-tree allowlist; unpatchable advisories go in .github/audit-allowlist.json
metadata: 
  node_type: memory
  type: project
  originSessionId: b59ec4b9-01b8-4bc1-8f5c-2729fd0f5600
  modified: 2026-08-07T22:17:33.046Z
---

Since 2026-08-07 the audit workflow runs
`scripts/audit-with-allowlist.mjs` instead of raw `npm audit` (which has no
exception mechanism). Any high+ advisory fails UNLESS listed in
`.github/audit-allowlist.json` with a per-tree `dir`, a `reason`, and an
`expires` date. Past expiry the advisory fails again; an entry whose
advisory no longer appears in that tree's audit ALSO fails (stale-entry
ratchet), so exceptions cannot linger.

**Why it was added:** image-size shipped two high DoS advisories with no
patched release (affected <=2.0.2, via pptxgenjs), which blocked every PR.
The parsers were unreachable here (text-only pptx decks). Dependabot alerts
54/55 were dismissed as not_used on 2026-08-07.

**Cleared 2026-09-25:** 2.0.3 (and 2.0.4 the same day) patched both
GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr. Alert 67 reopened the JXL/HEIF
advisory once GitHub recorded a patched version. The root override is
`image-size: ^2.0.4` because pptxgenjs 4.0.1 depends on `^1.2.1` and a
direct dependency cannot move that copy. Both allowlist rows were deleted
in the same change. Do not re-add them.

**Registry 503 is not a clean tree.** `npm audit --json` still prints JSON
when the advisory endpoint is in maintenance (`statusCode: 503`, no
`vulnerabilities` object). Scoring that as zero advisories trips the stale
ratchet on whatever rows are allowlisted and fails `audit (.)` / Security
Audit as if the lockfile changed. The wrapper must retry across most of the
10-minute CI job, then exit 2 when the JSON is not an audit report. Observed
on PR #1876 (2026-09-19) while npmjs.org was in maintenance; PR #1875 was
green earlier the same day on the same lockfile.

**How to apply:** When the Security Audit check fails, first try
`npm audit fix`; only an advisory with no patched release goes in the
allowlist, scoped to its tree, with a short expiry. When a patched release
ships, bump the override and delete the allowlist rows in the same PR (the
stale-entry ratchet fails the run if a row outlives its advisory). Do not
delete allowlist entries because a 503 run reported them stale.
