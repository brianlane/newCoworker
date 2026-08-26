---
name: squash-merge-breaks-stacked-rebase
description: "After a squash merge, a branch stacked on the merged one cannot be rebased normally; use git rebase --onto to replay only your own commits"
metadata: 
  node_type: memory
  type: project
  originSessionId: 084428b0-2add-4cc2-bf15-891743d1d440
  modified: 2026-08-04T15:53:17.225Z
---

This repo squash-merges every PR. That means the branch's original
commits never become ancestors of `main`, so two things break in ways
that look like something else:

**Checking whether your work merged.** `git merge-base --is-ancestor HEAD
origin/main` always reports false after a squash merge, even when every
line of your work is on main. Verify content instead:
`git diff --stat HEAD origin/main -- <your paths>` (empty means merged),
or `git cat-file -e origin/main:<path>` per file.

**Rebasing a stacked branch.** If branch B was created on top of branch A
and A gets squash-merged, `git rebase origin/main` on B tries to replay
A's original commits, which now conflict with their own squashed selves,
often across many files at once. Replay only your own commits:

```bash
git rebase --onto origin/main <your-first-commit>^ <your-branch>
```

Seen 2026-08-04 stacking the auto-reload fast path (PR #1168) on the
follow-up PR (#1163): the naive rebase produced eight conflicted files,
`--onto` applied cleanly with zero.

Related: [[project_migration_restamp_empty_file_trap]] usually fires
right after this, because rebasing onto a newer main leaves your
migration stamped below the head.
