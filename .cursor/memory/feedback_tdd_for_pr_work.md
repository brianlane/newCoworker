---
name: tdd-for-pr-work
description: Every pull request behavior starts as a failing test
metadata:
  node_type: memory
  type: feedback
  originSessionId: ba-fitness-gaps
  modified: 2026-09-23T19:58:00.000Z
---

Use test-driven development for every pull request change.

**Why:** Coverage after the fact can pass while the behavior is only imported by the test. Knip's export ratchet caught `BLANK_MANUAL_EXTRACT_MESSAGE` that way on PR #1901. The trash-icon confirm shipped with no test until the same request.

**How to apply:** For a behavior change, write the test that fails, run it, then write the code until that test passes. A production export needs a production caller. Do not add a symbol to `.github/knip-exports-baseline.txt` to silence a new finding.
