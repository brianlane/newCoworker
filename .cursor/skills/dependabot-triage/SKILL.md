---
name: dependabot-triage
description: >-
  Diagnose and clear stuck or failing Dependabot PRs on New Coworker, including
  the auto-merge gate. Use when Dependabot PRs are failing, piling up, not
  auto-merging, or when asked to resolve dependency alerts.
---

# Dependabot triage

"Investigate all the failing Dependabot PRs, do not stop until they are
resolved and automatically merged" has been asked more than once. The failure
modes repeat, so diagnose against this list before investigating from scratch.

## How auto-merge actually works here

`.github/workflows/dependabot-automerge.yml` squash-merges a Dependabot PR
only when **all** of these hold. Anything less exits quietly, which is why a
PR can sit green-looking and unmerged:

1. Author is Dependabot (`dependabot[bot]` or `app/dependabot`).
2. PR is open and not a draft.
3. PR carries the **`dependabot-automerge` label**. Major updates
   deliberately do not get it, so they need a human.
4. Every check run for the head SHA has `status=completed` **and**
   `conclusion=success`. Not "not failed": success. A `neutral`, `skipped`,
   `cancelled`, or `action_required` conclusion blocks the merge, by design.
   Only `label-dependabot` and `cursor-auto-merge` are excluded. The Cloud
   Agent merger job skips on Dependabot PRs, and a skipped check is not a
   pass.
5. Legacy commit statuses (Vercel reports one) are all green.
6. **Zero unresolved review threads.** A Bugbot comment nobody resolved keeps
   the PR unmerged forever.
7. The head SHA has not moved since the run started.

The workflow triggers on `workflow_run` completion for CI / CodeQL /
Dependency Audit, and on `status` events, because Vercel's deployment status
often flips to success minutes after the last workflow finishes.

## Cloud Agent auto-merge (sibling)

Cloud Agent PRs are not Dependabot PRs. They are opened as the human who
started the run, on a `cursor/` branch, so this Dependabot author + label
gate cannot see them. `.github/workflows/cursor-automerge.yml` is the
sibling: same squash-merge path, plus Cursor Bugbot must conclude SUCCESS
and `mergeStateStatus` must be CLEAN on two reads. Drafts are the hold.
Do not diagnose a stuck Cloud Agent PR with the Dependabot label check.

## Diagnose in this order

```bash
gh pr list --author "app/dependabot" --state open \
  --json number,title,labels,mergeable,statusCheckRollup
gh pr checks <number>                     # which check is not "success"
gh pr view <number> --json labels         # is dependabot-automerge present?
```

Then match the symptom:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Checks green, PR sits unmerged | An unresolved review thread, or a check concluded `neutral`/`skipped` rather than `success` | Resolve the threads; find the non-success check |
| Bugbot check shows "skipping" | `NEUTRAL` means Bugbot has open findings, NOT that it was skipped | Address each finding and resolve the thread; re-triggering returns NEUTRAL again |
| No `dependabot-automerge` label | Major version bump, deliberately excluded | Review by hand; do not add the label to dodge review |
| Vercel Deploy or E2E failing | These are no-op'd on Dependabot PRs so auto-merge can pass (PR #630). A real failure means that guard regressed | Check the workflow condition |
| Same advisory keeps reopening | Transitive dependency; bumping the direct one does nothing | Add a `overrides` pin in the owning `package.json` (the `@hono/node-server`, `adm-zip`, `sharp` precedents) |
| Dependabot check on main fails with "Override for X@Y conflicts with direct dependency" | X is listed both as a direct dep and as a literal versioned override. Dependabot rewrites the override to the new exact version and leaves the direct range, which npm rejects (`EOVERRIDE`) | Change the override to `"X": "$X"` so nested copies follow the direct pin. Do not delete the override: without it, nested copies can stay on the vulnerable range. `tests/dependency-overrides.test.ts` fails the PR if a dual-listed pin regresses to a literal |
| A lockfile tree is missed entirely | This repo has several: root, `vps/chat-worker`, `vps/voice-bridge`, `vps/data-api`, `vps/aiflow-render`, `cloudflare/email-worker`, `zapier` | Dependency Audit CI covers every tree (PR #743); fix the tree the alert names |
| An `aiflow-render` group PR fails `aiflow-render-playwright-pin` | The npm `playwright` pin and the Dockerfile `FROM` tag must match; the multi-ecosystem group bumps both in one PR, but a release that lands between weekly runs can arrive half-bumped | Wait for Dependabot's next run to fold the other half into the same PR, or bump the missing side (Dockerfile FROM or package.json) on the PR branch yourself. NEVER split the group back into separate npm/docker entries: two PRs each fail the guard until the other lands, which deadlocks automerge |

## Rules

- **Never weaken a check to make a bump pass.** The strict gate is the
  feature. If a check is wrong, fix the check in its own PR.
- **Never add the automerge label to a major bump** to get it through.
- **Do not force-merge** past a queued or skipped check (repo PR merge
  policy).
- A dependency bump that breaks a test is a real signal: read the changelog
  before assuming the test is wrong.

## Verify

Once the batch is clear:

```bash
gh pr list --author "app/dependabot" --state open --json number,title   # should be empty or majors only
gh api repos/:owner/:repo/dependabot/alerts --jq '[.[]|select(.state=="open")]|length'
```

Then watch main to green: the push-to-main run applies migrations and deploys,
and `main-failure-watch.yml` retries once before emailing on a real failure.
