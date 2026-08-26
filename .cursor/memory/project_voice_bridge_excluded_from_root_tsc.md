---
name: voice-bridge-excluded-from-root-tsc
description: "the root tsconfig EXCLUDES vps/voice-bridge, so its type errors pass CI and only break the redeploy"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f2b787e-f040-4fd9-ab8f-a9377a79fb28
  modified: 2026-08-17T21:34:25.178Z
---

`vps/voice-bridge` is its own npm package with its own `tsconfig.json` and a
`tsc` build, and the repo-root tsconfig lists it under `exclude`. So
`npx tsc --noEmit` (locally AND in CI's typecheck job) never sees it, vitest
does not typecheck, and its compiler runs for the first time INSIDE the Docker
image at redeploy, which is after the merge.

On 2026-08-17 two type errors in a bridge change (PR #1428) passed every gate,
merged with main green and Bugbot green, and then failed
`redeploy-voice-bridge.ts --all` on all 4 boxes. Main stayed green, the fix was
simply not live, and the only symptom was `0/4 redeployed` in the sweep output.
Worse, the diagnostic was almost lost: the run had been piped through
`tail -8`, which discarded the compiler errors.

**Why:** "all gates green" is meaningless for a package no gate covers, and the
deploy is a terrible place to discover it.

**How to apply:** when touching `vps/voice-bridge/`, also run
`cd vps/voice-bridge && npx tsc --noEmit`. CI now runs that same compiler in the
typecheck job (PR #1430), and CLAUDE.md's step 2 carries the warning, so this is
belt-and-braces. voice-bridge is the ONLY vps package with its own tsconfig +
tsc build, so nothing else in `vps/` has this hole. Also: never pipe a fleet
redeploy through `tail` when you might need to read why it failed. Related:
[[project_fleet_redeploy_check]], [[homelight-claim-click-silent-noop]].
