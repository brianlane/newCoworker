---
name: feedback_rebase_before_merging_a_slow_pr
description: "A PR that sat through review can go stale in its REASONING, not just its code; refetch main and re-read the rationale before merging, because GitHub's mergeStateStatus is computed from a base that may have moved"
metadata:
  type: feedback
---

On 2026-08-18 I was seconds from merging PR #1486 when Brian asked "are there
merge conflicts?" There were: the branch had fallen **12 commits behind main**
during review, and `docs/tenants/amy-laidlaw-real-estate.md` conflicted.

**Why:** I had read `mergeStateStatus: CLEAN` from GitHub, but that value was
computed before those 12 PRs landed. By merge time it had flipped to `UNKNOWN`
(recomputing) and I acted on the stale read.

**The part that actually mattered.** The conflict was not cosmetic. PR #1479
had merged in the meantime and given "Needs Follow Up (AI cadence)" its own
email arm. My PR's commit message, dossier section and PR body all argued
"tagging an email-only lead would start a cadence that does nothing", which had
become FALSE. The decision was still right, but for an opposite reason (it
would now DOUBLE-email, since the lead-source flows carry the same block
in-flow). I would have merged a permanent, confidently-worded, wrong
explanation into the repo's history.

**Why:** a long-lived PR's code is protected by CI. Its REASONING is not.
Nothing re-checks a rationale against a main that moved underneath it.

**How to apply:** before merging any PR that did not go green-and-merge in one
pass, `git fetch origin main` and check `git rev-list --count HEAD..origin/main`.
If it is non-zero: rebase, and re-read every "I deliberately did NOT do X
because Y" claim in the commit message, PR body and any docs, against what main
now says. Read the merged neighbours' commit messages, not just their diffs.
Treat `mergeStateStatus` as a cached value, never as proof. See
[[project_pr_checks_appear_in_waves]] and
[[project_batch_merge_cancel_in_progress]].
