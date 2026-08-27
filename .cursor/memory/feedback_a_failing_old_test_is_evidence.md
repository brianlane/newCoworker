---
name: feedback_a_failing_old_test_is_evidence
description: "When my change breaks an old test, read WHY it exists before updating it; twice the test was describing a safety property my change had just violated"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40416682-0de3-4391-a713-4b717801572b
  modified: 2026-08-10T05:04:05.029Z
---

Aug 10 2026. Splitting the HQ intro reply into two tailored emails broke a
test asserting the send sits **directly after** the approval gate. My first
move was to mark it stale and move on. Its comment said why it existed:
`approval_gate`'s skip semantics guard "the step directly after it".

That was not stale. It was describing the bug I had just written. The worker's
skip advance was hard-coded to ONE step, so a gate followed by two sends would
skip the first and run the second, mailing an unapproved draft to a stranger
from Brian's own address. A cooling gate took the same path with the same hole.
The fix was an engine change (`guardsNextSteps`), not a test edit.

**The pattern:** a test that breaks under my change is one of two things, and
they look identical at the failure line.

1. It pinned a detail I deliberately changed. Update it, and invert rather than
   delete so the case keeps existing (see the booking-title and branch-arm
   rewrites).
2. It pinned a PROPERTY my change quietly violated. Then the test is right and
   my code is wrong.

Telling them apart takes ten seconds: read the comment above the assertion, and
ask what breaks in production if this stops holding. Tests in this repo carry
their reason in a comment precisely for this, so there is no excuse for
skipping that step.

**Never reach for `.skip`.** The tree has zero skipped tests, and I briefly
added one here. A skip looks like a decision and reads like an accident later.
Either the assertion is still true and gets fixed, or it is genuinely obsolete
and gets rewritten into what is now true.

When a broken guard turns out to be case 2, prefer a test that DERIVES its
expectation over one that hard-codes it: the replacement counts the sends
actually sitting behind the gate and compares that to what the gate declares,
so adding a third fails loudly instead of silently escaping the approval.

Related: [[feedback_assert_the_producer_not_the_fixture]] and
[[feedback_verify_the_column_is_written]] are about tests I wrote that proved
too little; this is about a test someone already wrote that proved more than I
credited.
