---
name: gh-merge-delete-branch-worktree-trap
description: gh pr merge --delete-branch aborts in a worktree and leaves the REMOTE branch alive; verify with ls-remote
metadata: 
  node_type: memory
  type: project
  originSessionId: 551a640b-f18d-4d1a-9ff7-f42c5788ff84
  modified: 2026-08-21T20:42:44.323Z
---

Running `gh pr merge --delete-branch` from a Claude Code worktree fails its
local cleanup ("fatal: 'main' is already used by worktree at
/Users/brianlane/newCoworker", since main is always checked out in the main
checkout) and then SKIPS the remote branch deletion too. The merge itself
succeeds. Observed on PR #1582 (2026-08-21): `git ls-remote --heads origin
<branch>` still returned the branch after the "merged" result.

**Why:** every session on this repo merges from a worktree, so the local
checkout-of-main step can never succeed, and gh aborts the whole cleanup
rather than continuing to the remote delete.

**How to apply:** after any `gh pr merge --delete-branch` from a worktree,
verify with `git ls-remote --heads origin <branch>` and delete the leftover
with `git push origin --delete <branch>` during worktree cleanup.
