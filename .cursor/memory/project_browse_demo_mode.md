---
name: project_browse_demo_mode
description: Browse steps can be taught by demonstration; live on all 4 boxes since Aug 20 2026
metadata: 
  node_type: memory
  type: project
  originSessionId: 1af9272b-e3a7-4a6a-b798-48f38b079065
  modified: 2026-08-20T17:41:56.421Z
---

A browse step can be authored by DOING the workflow once: dashboard panel
"Teach it by doing it once" drives a live page on the tenant's own render
sidecar, one interaction per HTTP turn, and each interaction is executed for
real via the engine's own `runAction` and recorded as a normal browse action.
Shipped Aug 20 2026 in PRs #1550 (sidecar `/demo/start|act|stop` + demo.mjs),
#1554 (app lib + routes), #1555 (panel + README), #1559 (AI suggestions),
#1561 (CLI 404 + Amy dossier).

**This is the surface that ACTS.** The page picker and dry run judge a page
AS LOADED; demonstration walks past that (wizards, modals), which is the
whole point, and why every click is real and cannot be un-clicked.

Load-bearing details:
- A screenshot-pixel click is resolved to a durable action BEFORE executing:
  data-test handle, then accessible name, then a letters-only id, and the
  candidate is recorded only if the engine's `locateActionTarget` lands back
  on that same element. Prevents the same-text-twin trap.
- Destructive labels (the probe's DESTRUCTIVE_TARGETS, three lockstep
  copies) return `needs_confirm` SIDECAR-side; the demo confirms rather than
  refuses, because clicking Accept may be the workflow being taught.
- `unknown_demo` is HTTP 200, NEVER 404: 404 means the box predates the
  paths ("not updated yet"). Different remedies, different people.
- Session caps: 2 per box, idle 5m, hard 20m, 15 actions. The action cap
  counts what the SESSION performed, and the panel takes
  max(recorded.length, executedCount) so a removal cannot fake room and a
  recording kept across a restart cannot exceed the schema cap.
- Verified live on Amy's box read-only: screenshot pixel ->
  `click_text("Learn more")` -> navigated; Clever login landed on her real
  dashboard with zero acts. See [[project_fleet_redeploy_check]]: the paths
  only exist after `tsx debug/redeploy-aiflow-render.ts --business-id <uuid>`.
