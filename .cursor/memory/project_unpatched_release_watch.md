---
name: unpatched-release-watch
description: Monday GitHub Action queries npm for override pins waiting on a patched release and opens one issue when the lockfile is still behind
metadata:
  node_type: memory
  type: project
  modified: 2026-09-12T17:00:00.000Z
---

Dependabot does not bump `package.json` `overrides`, and a `>=0.6.0` floor
leaves the lockfile on the old copy until something regenerates it. A PR
comment ("raise the pin when 0.6.1 publishes") is not a reminder. That is
how adm-zip sat on 0.6.0 for a day after 0.6.1 shipped (2026-09-11,
GHSA-vwc7-r8mq-g2x9).

**How we know, automatically:**

1. When you pin an override because npm has no patched release, add a row
   to `.github/unpatched-release-watch.json` in the same PR (`package`,
   `dir`, `minRelease`, `advisory`, `reason`).
2. `.github/workflows/unpatched-release-watch.yml` runs Mondays at 04:48
   UTC. `scripts/unpatched-release-watch.mjs` compares the lockfile copy
   to `npm view <package> version`. If the registry has `minRelease` and
   the lockfile does not, it exits 2 and the workflow opens (or updates)
   one issue labeled `unpatched-release-watch`.
3. Bump the override and lockfile, then **delete the watch row**. A leftover
   row fails the job as stale (same ratchet as the audit allowlist).
4. `zapier/` is in `.github/dependabot.yml`, so weekly updates refresh that
   lockfile. That still does not bump an override by itself if no direct
   dep moved, which is why the waitlist exists.

Empty waitlist is a successful no-op. `node scripts/unpatched-release-watch.mjs`
is the local check.
