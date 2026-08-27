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

**Why:** image-size shipped two high DoS advisories with NO patched release
(affected <=2.0.2, patched: none, via pptxgenjs), which blocked every PR in
the repo. The upstream repo was ARCHIVED Jun 3 2026, so no patch will ever
ship; the parsers are unreachable here (text-only pptx decks). Dependabot
alerts 54/55 dismissed as not_used 2026-08-07; entries expire 2026-11-07
(quarterly re-review, exit criteria named in the entry).

**How to apply:** When the Security Audit check fails, first try
`npm audit fix`; only an advisory with no patched release goes in the
allowlist, scoped to its tree, with a short expiry. When image-size ships a
patch, bump it and DELETE the entries (the ratchet will demand it anyway).
