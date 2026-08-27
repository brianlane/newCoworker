---
name: project-call-window-skip-not-placed-trap
description: "A callWindow with outside skip resolves to not_placed, which is NOT no_answer, so every downstream gate keyed on no-answer silently does nothing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 954ccfd8-d282-4dee-9a62-9fe6b95d9733
  modified: 2026-08-12T02:40:26.093Z
---

`place_ai_call` with `callWindow: { outside: "skip" }` resolves the step to
**`not_placed`**, not `no_answer`. Anything gated on `call_outcome equals
no_answer` (a follow-up text, a "tag them for the cadence" step, a retry rung)
therefore does nothing at all when the window is closed.

I wrote this bug twice in one session (Aug 11 2026, PRs #1307 and #1308) and
Bugbot caught both:

- **The cadence** waits exactly 72 hours per round, so all eight rounds land at
  the SAME clock time as the first. A lead tagged at 2am skipped its call AND
  its text, then hit 2am again three days later, for all eight rounds: the lead
  would never have been contacted at all. Fixed with `outside: "defer"`, which
  parks round 1 until 08:30 and gives every later round that daytime phase.
- **ReferralExchange first contact** carried a window at all. First contact on
  a fresh lead should have none (Clever's attempt-1 dial has none), because
  speed to lead is the point; only RETRY rungs need windows, since a redial is
  the thing that must not land at 3am.

Related trap from the same PRs: gating "keep going" on `call_outcome equals
no_answer` also ends a ladder on a transient `failed` or a dial-cap
`not_placed`. Stop on REACHED instead (empty arms for `transferred` /
`answered`, work in `else`), which is what the Clever spoke check already does.

See [[project-amy-open-findings-aug11]] and
[[feedback-check-for-a-shared-mechanism-first]].
