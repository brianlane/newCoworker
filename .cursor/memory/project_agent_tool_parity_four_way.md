---
name: agent-tool-parity-four-way
description: adding a coworker tool means registry + deploy-client.sh seed + TOOL_GATES + voice bridge in lockstep, then a fleet reseed; inline surfaces are exempt
metadata:
 type: project
---

Adding a tool to the AI coworker is never one file. `tests/agent-tool-seed-parity.test.ts`
enforces a four-way lockstep and fails the PR until all of it agrees:

1. `src/lib/agent-tools/registry.ts` : the toggle each surface renders.
2. `vps/scripts/deploy-client.sh` : the Rowboat workflow seed. The test
 EXECUTES the seed's own jq program, so a syntax error fails here rather
 than at the next tenant's provision. **The jq program must contain no
 apostrophes** (bash would truncate it), so write tool descriptions without
 them.
3. `TOOL_GATES` in `src/lib/agent-tools/rowboat-gates.ts` : the dispatch
 allowlist for `/api/rowboat/tool-call`. Every gate resolves its toggle from
 the registry, so a Rowboat tool ALWAYS needs a registry entry.
4. The voice bridge's declarations (voice tools ship with the bridge, not the
 workflow).

Two exemptions worth knowing:

- **Dashboard** has `DASHBOARD_NAME_MAP`; mapping a toolKey to `null` marks it
 INLINE-ONLY by design. That is the established posture for anything needing
 verified caller identity (`manage_employee`, `flag_contact_spam`, the MCP
 bridge groups). **SMS has no exemption**: every configurable sms registry
 tool must be in the seed.
- `email` and `slack` are inline engines with **no seed at all**
 (`src/lib/email-coworker/turn.ts`, `src/lib/slack/worker.ts`), so a tool for
 those surfaces needs its own declaration and handler there, not a seed entry.

## The seed change is not live until a fleet reseed

Boxes freeze their workflow at deploy time. After merging, run
`tsx debug/reseed-agent-tool-parity.ts --all` (REPORT-ONLY by default; add
`--apply`). It renders canonical from `deploy-client.sh` itself, unions
missing tools in, never removes, and is idempotent.

You can dry-run it BEFORE merging from the worktree holding the seed change,
which proves the edit is well-formed and shows the per-box diff.

**`--apply` does more than add your tool.** On 2026-08-24 four of five boxes
also listed a long set of `(drifted copy)` declarations (`send_email`, the
calendar tools, `generate_image`, the webchat tools): pre-existing drift from
earlier tool waves that the converge also repairs. Say so before running it.

Related: [[platform-only-tools-need-four-enforcement-points]].
