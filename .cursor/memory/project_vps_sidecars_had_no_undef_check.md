---
name: project_vps_sidecars_had_no_undef_check
description: vps/**/*.mjs ship with no build step and no typechecker; eslint no-undef was OFF until PR #1570, so a deleted function passed every gate.
metadata:
  node_type: memory
  type: project
---

The VPS sidecars (`vps/data-api`, `vps/aiflow-render`, `vps/chat-worker`, `vps/voice-bridge`) ship as plain ESM with no build step. Until PR #1570, `no-undef` was not enabled for them, so **nothing in the repo caught a reference to a name that does not exist**.

Proven the hard way on 2026-08-20: extracting `filters.mjs` out of `vps/data-api/server.mjs` also deleted `pool`, `bearerOk` and `clientError`, which sat between the cut anchors. `node --check` passed (it validates syntax, not references). `npm test` passed at 22963 tests and 100% coverage, because nothing imports `server.mjs` at all: it exits at import without `DATABASE_URL`. `npx eslint .` passed. Only Bugbot caught it. The container would have bound its port and thrown `ReferenceError` on the first request.

`eslint.config.mjs` now runs `no-undef` over `vps/**/*.mjs` with node globals declared.

**Why:** the three gates that normally back each other up all have a blind spot on this code at once, and the blind spots line up.

**How to apply:**
- `node --check` is NOT verification of a refactor in these files. Run `npx eslint vps/...` after moving code between sidecar modules.
- The Dockerfiles list source files BY NAME (`COPY server.mjs filters.mjs ./`), so a new module also needs that line, or the image lacks it and the container dies at startup. That took Amy's render sidecar offline on 2026-08-17. `tests/vps-dockerfile-copies-imports.test.ts` guards every sidecar.
- Sidecar code cannot be unit-tested while it lives in a `server.mjs` that exits at import; extracting is what makes it testable, which is worth doing for anything that turns request input into SQL.

See [[project_residency_read_seam_gaps]] and [[project_fleet_redeploy_check]].
