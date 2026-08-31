---
name: translator-interpret-flake
description: "The interpreter cue is NOT drifting: it scores 79/80. The nightly went red because this file was the one live suite with no retry"
metadata: 
  node_type: memory
  type: project
  originSessionId: e309beb5-9a76-4242-94c0-2a62832aad63
  modified: 2026-08-28T23:38:14.582Z
---

Aug 28 2026. `tests/e2e/translator-interpret.e2e.test.ts` took the nightly red
twice in one night on direction assertions (expected Spanish, got English, and
the reverse). It read exactly like live-model drift on
`translatorModeCue`. **It was not.**

Scored against the live model on the worst case (the 3-turn one, where a
colleague turn is already in history before the caller speaks), 80 samples:

| cue | score |
|---|---|
| shipped cue | **79/80** |
| + "interpret only the most recent turn" | 80/80 |
| + "never reply in the same language you just heard" | **10/12, WORSE** |
| + "work out who is speaking from the language" | no change |

**One miss better in 80 is not evidence**, so no cue change shipped. The
"never echo" candidate is the cautionary one: it scored measurably worse,
falling back to the receptionist persona ("Hi, I'm calling with Amy Laidlaw's
office"), which is what editing a live voice prompt on a hunch buys you.

WHAT THE SINGLE MISS SAYS. It answered `"Hola, mi nombre es Dave."` : turn ONE
translated, not the turn just heard. The model occasionally interprets an
EARLIER turn. Nothing labels the speaker in the history and nothing can
(production is live audio), so the model infers the speaker from the language,
and at temperature 0 the remaining variance is entirely server side.

THE ACTUAL FIX was `retry: 1` on the file's three cases.
`hq-inbox-classify.e2e.test.ts` retries 21 of its 22 cases; this file retried
NONE, so an ordinary ~1% wobble could take a whole nightly red. It is the only
live e2e file whose flakiness had no absorber. Deliberately not a bigger
hammer: `e2e-nightly.yml` already retries the suite once, so a real regression
still has to survive four attempts, and a genuine drift (wrong language most
of the time) still fails.

THE RATE IS BURSTY, which is the trap. Measured 2 fail / 6 runs around 22:30
UTC, then 0 fail / 80 samples ninety minutes later. Do not conclude "fixed"
or "not reproducible" from one window; measure, and say when you measured.

Also ruled out, do not re-investigate: NOT PR #1715 (vps/voice-bridge is
byte-identical across it) and NOT PR #1701 (its only voice-bridge change was
respelling a comment; the spelling line is not in this prompt, verified by
building `intakeSystemInstruction` and testing for "American English").

Related: [[feedback_score_prompt_changes_against_outcomes]],
[[feedback_prove_prompt_fixes_against_deployed]],
[[project_extraction_prompt_style_lines]].
