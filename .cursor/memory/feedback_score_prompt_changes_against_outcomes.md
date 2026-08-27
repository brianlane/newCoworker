---
name: feedback_score_prompt_changes_against_outcomes
description: "A well-argued prompt fix is a hypothesis: grade it against cases whose real outcome you know, because two plausible ones each scored WORSE than the bug"
metadata:
  type: feedback
---

Aug 25 2026, the meeting-minutes classifier returning `unclear`. I diagnosed
it correctly (the 6,000-char budget tail-clipped PAST the end of the minutes,
so the model got pure dialogue) and then proposed two fixes I could argue for
in detail. **Both scored worse than the bug when measured.**

- "Feed it only the minutes, as the prompt already claims." Fixed the
  complained-about meeting, and invented a `signed` for a prospect who never
  signed while losing a real one. 1/3 against 2/3 for the shipped version.
- "Label the excerpt as the closing part of the call." Factually false, since
  the ingest stores the OPENING and discards the rest. Cost a real signup its
  `signed` on 5 of 5 runs.

Only a factorial run (guard x input, 5 samples per arm) separated them, and it
also showed the two halves of the final fix were BOTH needed: either alone
scored worse than neither.

**Why:** a classifier prompt has no sharp edges. Reasoning tells you where the
signal is; it does not tell you what the model does with it, and a change that
is obviously right can move three meetings in three directions.

**How to apply:** before touching a prompt that writes to the CRM, assemble
cases whose real outcome is knowable from OUTSIDE the text (did a business row
appear, did they pay, did the deal close) and score N runs per case per arm.
Report the score, not the argument. Then commit the harness:
`debug/meeting-classify-score.ts` exists for exactly this, and
`debug/classify-probe.ts` is the older one for lead-reply categories.

Two traps worth naming:
- **Report instability separately from wrongness.** Bobby returned `unclear`
  on 8 of 13 runs of identical input; the modal answer being silently right
  sometimes is still a bug.
- **Check your ground truth is derivable from the input.** I first graded a
  meeting `follow_up` because the person had not paid yet. Nothing in a call
  recording separates "will sign up tomorrow" from "will sign up eventually":
  two meetings said it in nearly identical words and one became a tenant the
  next day. They must get the SAME label, and which one is a product rule
  (`LIFECYCLE_STAGE_TAGS`), not a classifier question.

Related: [[feedback_prove_prompt_fixes_against_deployed]] is the before/after
half of this (reproduce the failure on the deployed prompt first);
[[feedback_a_failing_old_test_is_evidence]] is the same humility about code.
