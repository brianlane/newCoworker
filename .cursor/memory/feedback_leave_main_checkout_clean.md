---
name: leave-main-checkout-clean
description: "When a session ends, /Users/brianlane/newCoworker must have a clean working tree. Memories belong in the worktree PR, never as leftover uncommitted files on main"
metadata:
  node_type: memory
  type: feedback
  modified: 2026-08-31T21:15:00.000Z
---

**When an agent is done, the main checkout must be clean.** `git status` in
`/Users/brianlane/newCoworker` must show `nothing to commit, working tree
clean`.

This is how it fails: Cursor's workspace is the main checkout, so writing a
memory or a note dirties main even when the code change lived in a
worktree. Those files then sit uncommitted, block `git pull --ff-only`,
and the next session starts from a dirty, stale tree.

**How to apply:** write memories and any other session files in the
worktree so they ship with the PR. Copy anything that already landed on
main into the worktree before you open the PR (or before you remove the
worktree). If there is no PR, discard the leftovers or put them in one.
Never commit them on main. Never walk away with a dirty main.

The README carries the full cleanup steps under "Leave main clean".

Related: [[always-babysit-never-ask]], [[main-checkout-is-stale-never-copy-files]].
