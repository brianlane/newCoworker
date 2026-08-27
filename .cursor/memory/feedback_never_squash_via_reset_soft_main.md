---
name: never-squash-via-reset-soft-main
description: git reset --soft origin/main to squash silently reverts everything merged since you branched; reset to the original base sha and rebase --onto instead
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e3481619-3f5a-4ae1-969a-b6f3d894c4c2
  modified: 2026-08-17T16:08:31.076Z
---

**Never squash with `git reset --soft origin/main`.** `origin/main` moves while
you work (this repo merges constantly, and `gh`/push commands update the ref
without you asking). `--soft` moves the PARENT forward but keeps your OLD index,
so the commit records a stale tree against a new parent, and git expresses the
difference as deletions of everything merged in between.

**Why:** on 2026-08-17, squashing PR #1419 this way produced
`66 files changed, 1774 insertions(+), 2571 deletions(-)`, silently reverting
PRs #1412 to #1417 including two migrations already applied to production
(`20260822160258_booking_page_channel.sql`,
`20260822162850_telnyx_cost_unattributed_sender.sql`). It looks like a clean
single commit; nothing in `git log --oneline` hints at it.

**How to apply:**
- Squash by resetting to the ORIGINAL base sha you branched from, then replay:
  `git reset --soft <original-base>` → commit → `git rebase --onto origin/main <original-base>`.
- After any squash or rebase, verify before pushing:
  `git show --diff-filter=D --name-only --format="" HEAD` must be empty, and
  `git show --stat HEAD | tail -1` must match the size of YOUR change.
- The Supabase Drift Check is what catches this ("Remote migration versions not
  found in local migrations directory"). Treat that message as "my branch is
  missing migrations", never as a flake. See [[project_supabase_ipv6_direct_host]].
- Related: [[project_squash_merge_breaks_stacked_rebase]] covers the other
  direction (rebasing a stacked branch after its parent squash-merged).
