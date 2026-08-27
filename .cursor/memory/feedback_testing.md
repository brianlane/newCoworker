---
name: full-test-coverage-requirement
description: All tests must pass with 100% coverage
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8dcda517-09ad-41db-9cef-57a78776ed70
  modified: 2026-08-17T21:40:42.090Z
---

The command `npx vitest run --coverage` must pass with full coverage.

**Why:** Ensures code quality and that all code paths are tested.

**How to apply:** When making code changes, ensure new code has corresponding
tests and that running `npx vitest run --coverage` completes with 100%
coverage.

Two traps, both hit on 2026-08-17 (PR #1432):

- The gate is **not scoped to `src/lib/**`**. `supabase/functions/_shared/**`
  is measured too, and the CI failure names the file and the uncovered line
  numbers (`late_claim.ts | 100 | 97.93 | ... | 195,267`).
- **Re-run with `--coverage` after every fix.** Fixing a failing test and
  re-running plain `npx vitest run` passes while the coverage gate still
  fails, so CI catches it instead of you. Running coverage on a SUBSET of
  files is also useless: the thresholds are global, so a subset run always
  reports ~1% and errors.

Unreachable branches are the usual cause. Delete them rather than testing
around them: a `?? ""` on a value that is always a string, or an `if (found)`
on a lookup that cannot miss, is better rewritten so the impossible case
does not exist (e.g. carry an array index as the opaque id so the lookup back
is a total index). Related: [[feedback_pipe_exit_code_masks_failures]].
