---
name: stash-is-repo-global-in-worktrees
description: "git stash in a .claude/worktrees checkout shares the stash stack with every other worktree; a no-op stash + pop grabs another session's old entry"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8fa7cd7e-5e73-4763-b016-93d452753587
  modified: 2026-08-10T21:50:51.546Z
---

In this repo, every Claude Code session worktree shares one git common dir, so
`git stash` uses a REPO-GLOBAL stack. Two traps hit together on 2026-08-10:
if you `git stash` with no tracked changes (untracked files are not stashed
by default), the stash is a silent no-op, and the following `git stash pop`
pops SOMEONE ELSE'S old entry, exploding unrelated conflicts (voice-bridge,
AiFlow files) into your clean tree.

**Why:** stash refs live in the shared common dir, not per worktree, and old
entries from months-ago sessions linger (`stash@{0}` "voice wait_for_call
WIP", `stash@{1}` on main from PR #709 era).

**How to apply:** never use bare `git stash` to move between branches in a
session worktree. Untracked new files simply travel across `git checkout`
untouched, so switch directly; for tracked edits, commit a WIP commit on the
branch instead. If a pop ever explodes with foreign conflicts, `git reset
--hard HEAD` restores the tree and the kept stash entry stays intact for its
owner. Related: [[squash-merge-breaks-stacked-rebase]].
