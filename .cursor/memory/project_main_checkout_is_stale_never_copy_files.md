---
name: main-checkout-is-stale-never-copy-files
description: "The main checkout's local main branch runs dozens of PRs behind origin/main; copying a whole file from it into a worktree silently deletes newer content"
metadata:
  node_type: memory
  type: project
  originSessionId: 8fa7cd7e-5e73-4763-b016-93d452753587
  modified: 2026-08-15T16:38:28.334Z
---

`/Users/brianlane/newCoworker` (the main checkout) is NOT kept current: on
2026-08-12 its local `main` sat at `507bc88d` (#1281) while `origin/main` was
`0274f8bc` (#1317), roughly 36 PRs behind. Session worktrees branch from
`origin/main`, so they are AHEAD of the main checkout.

The trap: running an edit script with `cd /Users/brianlane/newCoworker` and
then copying the whole file into the worktree. That copy reverts every change
made since the main checkout last pulled. It happened with `messages/en.json`
and `es.json`: the copy silently deleted the entire `marketing.chatgptPage`
block (a whole page's catalog) in both languages. Only
`tests/metadata-brand-suffix.test.ts` caught it, reporting the key as
"missing from en.json" for a page the change never touched.

**Why:** whole-file copy is last-write-wins across two different base
commits, and a deletion of unrelated keys produces no conflict and no
obvious diff signal when the file is thousands of lines.

**How to apply:** never edit in the main checkout and copy across. Run edit
scripts with the worktree as cwd (bare `python3 - <<PY`, no `cd`), or restore
from git first: `git checkout origin/main -- <paths>`. If a copy already
happened, verify with `git show origin/main:<path>` versus the working copy
before committing. When a guard test names a file or key the change never
touched, suspect a clobber rather than a flaky test.

**Two more shapes of the same hazard, both seen 2026-08-15:**

- A `cd /Users/brianlane/newCoworker &&` prefix on an edit command silently
  writes the edit into the STALE checkout instead of the worktree. `tsc`
  catches it (the symbol is missing where you expected it), then
  `git checkout -- <path>` there and re-run with the worktree as cwd.
- **Tools that diff live state against your working tree report false drift
  from a stale branch.** `debug/read-cron-jobs.ts` run from a branch
  predating a migration reports the new job as "not defined in any
  migration". Run it from a checkout of `main`. Reported by the
  VPS/Hostinger refund session, not verified here.

Related: [[a-failing-old-test-is-evidence]],
[[stash-is-repo-global-in-worktrees]].
