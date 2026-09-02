---
name: pr-merge-main-deploy-mechanics
description: every PR-merge and main-deploy CI trap: waves, thread gate, stale NEUTRAL, wedged status, cancel chains, watch by full sha
metadata:
 type: project
---

## feedback-bugbot-down-do-not-merge

If Cursor Bugbot is not reporting a check on a PR because Bugbot itself is
down (503, "No installations found" on cursor.com/automations/from-cursor/bugbot),
**do not merge**. Leave the PR open and wait: Brian will prompt when Bugbot is
back up.

Do NOT treat any of these as a substitute for Bugbot's review:
- all other CI checks passing,
- zero unresolved review threads,
- the repo's own `e2e-gate.sh` job (surfaced as the "Vercel Deploy" check)
 passing, even though that job's stated purpose is "wait for every other
 check to pass and all threads to resolve".

**Why:** Bugbot reliably finds real bugs in this repo, and it caught a genuine
Medium-severity defect on the very first Acuity PR (#1050 : a fleet rate
limiter that slept and then issued the request anyway, so it never actually
capped). Shipping without that review loses the highest-signal check in the
pipeline, and the merge policy in CLAUDE.md requires Bugbot to show SUCCESS.
The "findings that surface after merge still get fixed" clause covers a late
comment on a reviewed PR, not merging a PR Bugbot never looked at.

**How to apply:** When Bugbot is down, say so plainly, keep the PR open, and
stop the merge chain there rather than stacking more unmergeable work. Resume
only on Brian's explicit signal. See [[feedback-testing]] for the other
non-negotiable pre-merge gate.

## label-dependabot-check-skips

The `label-dependabot` GitHub check shows "skipping" on every human-authored
PR: its job condition only runs for Dependabot PRs, so no re-trigger will ever
make it pass. CLAUDE.md's merge policy says a skipping check counts as not
passing, but this one is conditional-by-design and every merged human PR
(verified on #1095, #1099, #1104 on 2026-08-01) merged with it skipping.

**Why:** Without this, an agent following the merge policy literally will
block forever on `label-dependabot` or push empty commits trying to
re-trigger it.

**How to apply:** When running the pre-merge checklist, require literal pass
on every check EXCEPT `label-dependabot`, whose "skipping" state is normal on
human PRs. Bugbot's NEUTRAL/"skipping" remains a real blocker per
[[bugbot-down-do-not-merge]] and CLAUDE.md.

## main-run-watch-trap

On newCoworker, after a squash merge, `gh run list --branch main --limit 1` frequently returns a SKIPPED `workflow_run`-event entry (Dependabot auto-merge, Main Failure Watch) rather than the merge's CI run, and `gh run watch --exit-status` on a skipped run exits non-zero, which looks like a deploy failure.

**Why:** those meta-workflows trigger off other runs and complete instantly as skipped.

**How to apply:** pick the run with `event == "push"` AND `name == "CI"` whose displayTitle matches the merge commit subject; CodeQL and Dependency Audit are also push-event runs with the same title, so event+title alone grabs the wrong workflow. Example: `gh run list --branch main --json databaseId,name,displayTitle,event --jq '[.[] | select(.event == "push" and .name == "CI")][0].databaseId'`.

**Second trap (2026-08-01):** main's CI uses cancel-in-progress concurrency (`group: ${{ github.workflow }}-${{ github.ref }}` in `ci.yml`). Merging PR B minutes after PR A CANCELS A's CI run; that is normal, not a failure. The newest push's CI run builds the fully merged state and its deploy/migrations cover the cancelled predecessors; only that newest run needs to reach green.

**Sharper form of the second trap (2026-08-05):** when merges land SECONDS apart, the superseded run may never exist at all rather than show as `cancelled`. Three merges (#1178 18:15:49, #1177 18:16:14, then #1180) left `gh run list --branch main --event push` with NO entry for the two intermediate merge commits, and `gh api repos/.../commits/<sha>/check-runs` returned only `auto-merge` for them, zero CI entries. Do not read that absence as "the deploy never ran" or go hunting for a lost run: confirm the intermediate sha is an ancestor of the tip (`git merge-base --is-ancestor <sha> <tipSha>`) and watch the TIP's CI run, which is the one that actually deploys. Checking each merge commit for its own run is the wrong question when several PRs merge in the same minute, which is exactly what a healthy Dependabot auto-merge produces.

**Third trap (2026-08-01):** `gh run watch --exit-status` exits 0 on a CANCELLED run, so a watcher's exit code alone can report a deploy that never happened. Always query the conclusion explicitly afterward (`gh api repos/.../actions/runs/<id> --jq '{status, conclusion}'`), and on `cancelled` confirm coverage by checking your merge commit is an ancestor of the superseding run's head (`git merge-base --is-ancestor <mySha> <newerHeadSha>`) before watching that newer run to green.

**Fourth trap, at the JOB level (2026-08-05):** `gh run watch --compact` marks every job of a cancelled run with `X`, which reads as "these jobs failed" even when the work SUCCEEDED. On `01f73953` the Vercel Deploy job showed `X`, but its log ends `Production https://...vercel.app`, `Aliased https://www.newcoworker.com`, `✓ Ready in 3m`, and only then `##[error]The operation was canceled` : production had already updated. Downstream jobs (IndexNow, E2E) then show `X` with 0s duration purely because they never started. Before concluding "main is red" or "production did not update", read the job log tail (`gh run view --job <id> --log | tail -40`); note `--log-failed` returns NOTHING for a cancelled job, so its silence is not evidence either. Cheapest independent check: `curl -o /dev/null -w '%{http_code}' https://www.newcoworker.com` plus `git show origin/main:<file>` to confirm your content is actually on main.

**Fifth trap (2026-08-13):** `gh run list --commit <sha>` silently returns NOTHING for a SHORT sha; the head_sha filter needs the full 40-char sha (`git rev-parse origin/main`). A watcher fed the short form concluded "no push run found" while the CI run was mid-deploy. With the full sha, the same listing also shows the skipped Dependabot `workflow_run` rows first, so still select `event == "push"` and the CI workflow, per the first trap.

**Sixth trap (2026-08-14), and it is the first trap in disguise:** the workflow-name filter is required in the COMMIT-scoped form too, not just the branch-scoped one. `gh run list --commit <fullSha> --event push` returns three push runs for one merge commit (CI, CodeQL, Dependency Audit), so `-q '.[0].databaseId'` picks whichever GitHub orders first. On `0f25090f` that was Dependency Audit, which completes in ~15s and reported `completed/success` while the CI run was 4 minutes into a deploy. A watcher built on `.[0]` announced main green before Vercel Deploy existed. **Never take `.[0]` of a run listing.** Always `select(.name == "CI")`, then verify the deploy at the job level (`gh run view <id> --json jobs`) so `Vercel Deploy` is explicitly `success` rather than merely absent.

**When the PR carried a MIGRATION (2026-08-04):** a green superseding run is still only evidence about the run, not about your schema change. Verify the effect directly, read-only, before calling it shipped: `curl` PostgREST for the new column (`?select=id,<new_column>&limit=1`; a missing column answers 400, a present one 200) using the credentials in the main checkout's `.env`. Cheap, and it distinguishes "the deploy was green" from "my DDL actually applied", which is the failure mode a cancelled predecessor run sets up.

## project_main_run_cancel_chain

`cancel-in-progress` means a merge landing behind yours kills YOUR main CI
run mid-flight. On a busy afternoon this chains: three consecutive merge
commits can all show `cancelled`, and watching "the push run for my full
sha" (the rule in [[project_main_run_watch_trap]]) then reports a failure
that never happened.

The question that is actually being asked is "did my commit reach a green
deploy?", so ask that: poll recent `CI` runs on main and accept the first
COMPLETED + SUCCESS run whose headSha has your commit as an ancestor
(`git merge-base --is-ancestor <mine> <runHead>`). Only that run deployed.

Aug 20 2026: PRs #1555 and #1559 both had their own runs cancelled this way
while the code was live and fine; the runs that carried them (`03d4b819e`,
`0a82a3eff`) were green. Also note the sibling trap when watching by sha:
filter runs by `workflowName == "CI"`, since `Dependency Audit` and `CodeQL`
run on the same commit and a naive first-match can report the wrong one
green while CI is still going.

## vercel-deploy-check-is-thread-gate

On newCoworker PRs, the `Vercel Deploy` job's first step is `bash .github/scripts/e2e-gate.sh` ("Wait for every other check to pass and all threads to resolve"). It exits 1 with `e2e gate: N unresolved review thread(s)` when any PR review thread is unresolved, so the check reads as a deploy FAILURE after ~8 seconds with no build having run. `E2E (live AI + AiFlows)` and `IndexNow ping` then show "skipping" because they depend on it.

**Why:** the gate deliberately does not poll for threads (they cannot self-resolve), so it fails fast instead of waiting.

The gate refuses for TWO reasons, and the second is easy to misread as an independent failure:
- `e2e gate: N unresolved review thread(s)`
- `e2e gate: check(s) failed, <names>` : another check (e.g. `CodeQL`) failed, so the gate will not deploy. Seen 2026-08-17 on PR #1419, where `Vercel Deploy` and `CodeQL` both showed as failing and looked like two problems; there was only one.

**How to apply:** when `Vercel Deploy` fails in seconds, do not diagnose a build problem. Read the job log first (`gh api repos/<o>/<r>/actions/jobs/<id>/logs | grep "e2e gate"`) to see WHICH refusal it is. For threads, fetch unresolved ones (`reviewThreads` via `gh api graphql`), fix or answer each, mark them resolved. For a failed check, fix that check and ignore `Vercel Deploy` until it is green: it clears itself. Either way, do not count the gate as a separate failure when tallying what is left. Related: [[bugbot-stale-neutral]], [[pr-checks-appear-in-waves]].

## project_pr_checks_appear_in_waves

On New Coworker PRs, `ci.yml` starts some jobs only after earlier ones finish,
so `gh pr checks <n>` lists a job only once it exists. Observed on PR #1181:
the list read all-pass twice and was wrong both times. `Vercel Deploy` was
created only after `Worker Integration` completed, and `E2E (live AI +
AiFlows)` only after `Vercel Deploy` completed. `IndexNow ping` appeared later
still. E2E budgets up to ~20 minutes for its gate poll, so the gap is long
enough to look settled.

**Why:** a check that has not been created yet cannot show as pending, so
"zero pending" is not the same as "all jobs done."

**How to apply:** never merge on a single all-pass reading. Poll until zero
checks are pending on at least two consecutive polls spaced ~30s apart, and
confirm `mergeStateStatus` is `CLEAN`. `label-dependabot` always shows
`skipping` on human PRs and is not a blocker, see
[[project_label_dependabot_check_skips]]. `cursor-auto-merge` is the same
kind of plumbing skip on non-`cursor/` PRs (and `auto-merge` on
non-Dependabot PRs); neither is a blocker. For the separate trap on the
post-merge side, see [[project_main_run_watch_trap]].

## cursor-cloud-agent-automerge

Cloud Agent PRs are authored as the human who started the run, on a
`cursor/` branch. Dependabot auto-merge cannot see them (it keys on the
bot author and the `dependabot-automerge` label).
`.github/workflows/cursor-automerge.yml` squash-merges those PRs when the
repo merge policy is satisfied, including the two extras the GitHub
ruleset does not require: Cursor Bugbot SUCCESS, and `mergeStateStatus`
CLEAN on two consecutive reads. Forks and drafts are skipped. Convert
back to draft to stop a merge. The workflow file always loads from the
default branch; do not add a `pull_request` trigger that would run the
copy from the PR under evaluation.

Cloud Agents must not stop the task at "PR opened, waiting for merge."
Mark the PR ready and keep going: fix Bugbot, watch main, post-merge,
worktree cleanup. The Action is the merge. You do not `gh pr merge`.

**Gate on the check COUNT, not just zero-pending** (2026-08-11, PRs #1287 and
#1294). `GitGuardian Security Checks` posts a commit status rather than a check
run and arrives minutes after everything else. Both times the list read **21
checks, 0 pending, 0 failing, Bugbot SUCCESS, 0 unresolved threads** and was
still not mergeable. A required context that does not exist yet cannot be
pending, so zero-pending said nothing about it.

Two corrections to the note above: the missing-context state is
`mergeStateStatus = BLOCKED`, not `UNSTABLE`, and a two-poll wait does not help
because both polls read the same incomplete list. What works is asserting
`total >= 22` alongside the other conditions. A merge script that checks only
pending/failing will happily bypass a required security scan.

Also: GitGuardian settles to `NEUTRAL` ("skipping"), not `pass`, and that is
normal here. It is not a blocking context, unlike a `NEUTRAL` Bugbot.

## project_skip_ci_literal_in_commit_message

GitHub honors the bracketed skip-ci markers anywhere in the HEAD commit's
message, for both push and pull_request events. On PR #1194 a commit whose
SUBJECT merely talked ABOUT the marker ("Carry [skip ci] on the heal
commit...") got zero CI/CodeQL/Dependency Audit runs on its own PR: only
Bugbot and GitGuardian (which are not Actions workflows) ran, and the PR sat
looking "2 checks, both pass" indefinitely.

**Why:** the marker is not parsed contextually; mentioning it IS invoking it.

**How to apply:** never write the bracketed form in a commit message, PR
title, or squash-merge subject; spell it "the skip-ci marker" instead. If a
PR shows a suspiciously tiny check list (2-3 checks) with nothing pending,
check `gh run list --branch <branch>`: no CI run for the head SHA plus a
marker in `git log -1 --format=%B` is this trap. Fix by amending the message
and force-pushing the PR branch. Related: [[project_pr_checks_appear_in_waves]]
(the other way a short check list lies).

Legitimate use in this repo: migration-order-heal.sh deliberately stamps the
marker on its re-stamp commits so the deploy-key push spawns no run (PR
#1194); tests/migration-order-heal.test.ts asserts it stays.

## project-main-failure-watch-twice-heuristic

`.github/workflows/main-failure-watch.yml` auto-reruns a failed push-to-main CI
run once, and if attempt 2 also fails it emails team@newcoworker.com asserting
"this is a real failure, not a runner blip." That claim rests on the assumption
that the **same** cause reproduced.

On Aug 6 2026 (run 31068979036, the #1209 merge) it was wrong. Attempt 1 died in
`supabase db push` on the IPv6-only direct host; attempt 2 died 30 seconds later
in `supabase link` on an unrelated `502` from Supabase's management API. Two
independent transient failures, read as one real one. A manual attempt 3 went
green.

**FIXED in PR #1225 (Aug 7 2026).** The rule now compares the failing step's
own output across attempts: a repeat emails at attempt 2 as before, a mismatch
earns one more retry, and attempt 3+ always emails. The logic lives in
`.github/scripts/main-failure-triage.sh` with 11 tests in
`tests/main-failure-triage.test.ts`; `ALERT_AT_ATTEMPT=2` reproduces the old
rule and six of them fail under it. The email no longer says "not a runner
blip"; it states how many attempts failed and whether the causes matched.

**How to apply:** when that email arrives, still check the run's current
conclusion first, since it may already be green from a later attempt. The email
is accurate about the moment it fired and goes stale the instant anyone
re-runs. If you need to compare attempts by hand, use
`gh api repos/brianlane/newCoworker/actions/runs/<id>/attempts/<n>/jobs`; note
that job name, step name, and the `##[error]` marker are all IDENTICAL for
unrelated failures, so only the lines leading up to the error tell them apart.

Note the email reports `Vercel Deploy` as the failed job, but the real failure
is usually a STEP inside it: "Apply migrations + deploy edge functions" runs
before the Vercel build, so a fast (~15s) Vercel Deploy failure is a Supabase
problem, not a build problem. A normal successful deploy takes about 3m17s.

One trap survives the fix: `main-failure-watch.yml` declares an explicit
`permissions:` block, which DENIES every scope it omits. It needs
`contents: read` for the checkout that fetches the triage script. Bugbot caught
that omission on #1225, where it would have killed the job before it retried or
alerted, which is worse than the bug being fixed.

Related: [[project-supabase-ipv6-direct-host]], [[project-main-run-watch-trap]]

## project-batch-merge-cancel-in-progress

`ci.yml` sets `concurrency: group: ${{ github.workflow }}-${{ github.ref }}` with
`cancel-in-progress: true`. Every push-to-main run shares one group, so **each
merge cancels the previous merge's run mid-flight**.

The deploy step (`Apply migrations + deploy edge functions`, then Vercel) starts
roughly **6 minutes** into a run, after the core jobs. That produces a
counterintuitive rule:

- **Merge the whole batch fast (inside ~6 min): SAFER.** Every intermediate run
 is cancelled during its test phase, before touching production. Only the final
 run deploys, and it bulk-deploys the entire tree (`db push` applies everything
 pending, `functions deploy` pushes ALL functions), so the end state converges.
- **Merge spaced 10 to 20 minutes apart: RISKIER.** Each run gets far enough to
 START deploying and is then killed partway, which is how you get a
 half-deployed set of edge functions.

Verified on 2026-08-07: 9 PRs merged in 42 seconds produced 8 `cancelled` runs
plus 1 `success` that deployed everything. Production served HTTP 200 and the
Vercel alias moved.

**Silence does not mean success.** `main-failure-watch.yml` only fires on
`conclusion == 'failure'`. A `cancelled` run emails nothing, so a batch merge
produces N-1 silent cancellations by design. Always watch the FINAL run
explicitly (the push-event run whose headSha equals the last merge commit) and
re-run it if it was clipped. The deploy is idempotent, so a re-run repairs any
partial state.

**Nothing re-tests the combination.** The branch ruleset has
`strict_required_status_checks_policy = False`, so branches never have to be up
to date with main. Each PR is tested only against the base it branched from, and
GitHub will merge all of them without ever testing them together. Before a batch
merge, simulate it: merge every PR branch into a scratch worktree off
origin/main, then run `tsc` and the full suite with coverage. That simulation is
the only test the combined tree ever gets.

Related: [[project-pr-checks-appear-in-waves]], [[project-main-run-watch-trap]],
[[project-main-failure-watch-twice-heuristic]]

## project_bugbot_stale_neutral

CLAUDE.md says a `NEUTRAL` Cursor Bugbot flips to `SUCCESS` once every review
thread is resolved. On PR #1244 (2026-08-08) it did not: both threads were
replied to and resolved, `reviewThreads` reported zero unresolved, and Bugbot
still read `completed/neutral` 20+ minutes later.

`.github/scripts/e2e-gate.sh` treats NEUTRAL as the one poll-able non-success
state, so `Vercel Deploy` sat polling and then failed with
`e2e gate: timed out after 20m waiting on: Cursor Bugbot: completed/neutral`.
That is a wasted 20-minute job, not a real failure.

**Fix:** push an empty commit. Bugbot re-reviewed the (now clean) PR and
returned `SUCCESS` within a minute. Same on PR #1245.

**How to tell this apart from a genuine NEUTRAL:** check unresolved threads
directly rather than trusting the check text.

```bash
gh api graphql -f query='{repository(owner:"brianlane",name:"newCoworker"){pullRequest(number:PR){reviewThreads(first:30){nodes{isResolved}}}}}' --jq '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)]|length'
```

Zero unresolved plus a lingering NEUTRAL means stale, so re-trigger straight
away instead of waiting out the gate. Non-zero means Bugbot is right and
CLAUDE.md's "go resolve my comments" reading applies.

Distinct from [[feedback_bugbot_down_do_not_merge]] (a 503'd Bugbot that
never reviews) and from [[project_pr_checks_appear_in_waves]].

## project-gitguardian-required-check-flaps

`GitGuardian Security Checks` is a **required** status check in the repo ruleset
`main: PRs with all checks green` (id 20477777). It is an external GitHub App,
and it intermittently does not run at all on a commit.

When that happens the PR looks fully green: `gh pr checks` lists ~20 checks, all
pass, Bugbot SUCCESS, zero unresolved threads. But `mergeStateStatus` stays
`BLOCKED`, because a required context that was never created cannot show as
pending. Observed twice on 2026-08-11 (a few hours apart), affecting main's own
head commit too, so it is repo-wide and not caused by a particular branch.

**Diagnosis** (checks attach to the COMMIT, not the branch or PR):

```bash
SHA=$(gh pr view <n> --json headRefOid -q .headRefOid)
gh api "repos/brianlane/newCoworker/commits/$SHA/check-runs" \
 -q '[.check_runs[]|select(.name|test("GitGuardian"))|.conclusion]|join(",")'
```

Empty output = never ran. It is a check-run, not a legacy commit status, so
`/commits/$SHA/status` shows an empty `statuses` array and is a red herring.

**What does NOT fix it:** force-pushing a new SHA, closing and reopening the PR,
or pushing the same commit to a fresh branch (the new branch reuses the commit's
existing check-runs). All three tried; none triggered a scan.

**What does:** Brian nudges it on the GitGuardian side, then it retroactively
scans the pending commits. Ask him, the same way [[feedback_bugbot_down_do_not_merge]]
works. Do not remove it from the ruleset's required contexts and do not
admin-bypass: that is a security-policy decision and CLAUDE.md forbids merging
past a non-passing required check.

A `neutral` conclusion right before it goes silent is consistent with a plan or
quota limit rather than an outage, worth mentioning when reporting it.

Related: [[project_pr_checks_appear_in_waves]] is the other reason "all green"
can be false, and both are why the merge gate must be `mergeStateStatus == CLEAN`
rather than "no check failed".

## project-wedged-check-status-blocks-vercel-gate

The `Vercel Deploy` job polls every other check before deploying. A GitHub
check-run can finish its work and report `conclusion=success` while its
`status` stays wedged at `in_progress`. The gate then polls it forever and
fails with `e2e gate: timed out after 20m waiting on: <name>:
in_progress/success`.

Seen on PR #1467, where `audit (vps/aiflow-render)` completed in 8 seconds and
stayed wedged.

**Remedy: re-run the WEDGED job first**, then re-run `Vercel Deploy`. Re-running
Vercel Deploy alone just polls the same wedged status and times out again. The
gate's own log says "no new commit needed unless code must change", and that is
accurate.

Distinguish from the other two Vercel Deploy failure causes before acting:
unresolved review threads (see [[project_vercel_deploy_check_is_thread_gate]]),
and a genuine build failure. Read the job log: the timeout message names the
blocker explicitly.

Related: [[project_pr_checks_appear_in_waves]],
[[project_gitguardian_required_check_flaps]].

## "Vercel Deploy: fail" usually means unresolved threads, not a broken build

When `Vercel Deploy` goes **fail** while every other check is green, read the
job log before investigating the build. That check is `e2e-gate.sh`, and its
first step refuses outright when review threads are open:

```
##[error]e2e gate: 2 unresolved review thread(s), fix/resolve them, then
re-run this job (threads cannot self-resolve, so polling would not help).
```

So a Bugbot round that posts findings makes `Vercel Deploy` fail as a
side effect, and `E2E` + `IndexNow ping` then show "skipping" because they are
gated on it. Nothing is wrong with the deploy. Resolve the threads and push;
the whole wave re-runs and passes.

Hit twice on 2026-08-24 (PRs #1591 and #1593), both times looking like a
deploy regression for a moment.

