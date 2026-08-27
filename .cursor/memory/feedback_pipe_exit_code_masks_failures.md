---
name: pipe-exit-code-masks-failures
description: "vitest/tsc piped into tail/grep reports the FILTER's exit code; use PIPESTATUS[0] before acting on \"green\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c74508ec-72f3-4a48-8023-e2517a7c2c97
  modified: 2026-08-14T22:02:16.067Z
---

Running `npx vitest run --coverage 2>&1 | tail -25` (or `| grep ...`) makes the command's exit status the PIPE TAIL's, not vitest's. This masked a red suite twice in one session (Aug 14 2026): a coverage-threshold failure printed "ERROR" in the output while the background task reported exit 0, and work continued (once all the way to `git push`) on a red tree.

**Why:** bash reports the last pipeline stage's status; `tail`/`grep` exit 0 whenever they ran (grep even exits 1 on no-match, inverting the signal).

**How to apply:** when filtering long test/build output, capture the real status in the same command: `... | grep -E "..."; echo "vitest: ${PIPESTATUS[0]}"` and read THAT number, never the task's exit code. Before commit/push/PR, the gate is the printed `${PIPESTATUS[0]}` (or run unfiltered). Related: [[full-test-coverage-requirement]].
