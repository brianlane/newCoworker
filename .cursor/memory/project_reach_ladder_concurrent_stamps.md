---
name: reach-ladder-concurrent-stamps
description: "Reach stamps were keyed by attempt only; a duplicate transfer_to_owner spawned concurrent ladders that hung up each other's legs"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-07T00:00:00.000Z
---

Investigated 2026-09-06 after Amy Laidlaw sent a call-history screenshot:
seven missed plus one 1-second connect from the coworker DID in two minutes.

## What happened (Miguel Angel Carmona, 20:14:53Z)

One Clever seller call (`v3:nP1c3dTy...`, flow `ffb54048`). Miguel asked to
be transferred. The model called `transfer_to_owner` eight times. The
dispatch in `gemini-telnyx-bridge.ts` is `void (async () => execute())()`,
so each call started a fresh `runReachLadder` on the same A-leg. Gemini Live
is not fully blocked on an outstanding function call: the second tool call
fired 6s before ladder 1 returned.

`record_reach_outcome` already ignores an older attempt when a newer one is
stamped. Later ladders therefore did not short-circuit on Gabby/Jason
(attempt 0/1) and **did** short-circuit the instant they reached Amy
(attempt 2): `readReachOutcome` accepted any same-attempt stamp, including
ladder 1's `{attempt: 2, status: no_answer}` for a different B-leg, then
`telnyx.hangup` on Amy's ringing phone about a second after it started.
That is "the call hangs up before she can answer."

The ladder also had no AbortSignal, so 13 more team dials went out after
Miguel hung up at 20:16:49. Side effects: ~24 pre-alert texts, 13 voicemail
connects on the teammates' already-ringing lines (AMD `machine` hangup).

## The 8/20 1-second connect is a different bug

She answered. `voice_reach_leg` stamped `answered` at 23:01:45. CDR:
`connected=1`, `call_sec=1`, `finished_at=23:01:45`. Dial was 23:01:25 with
`timeout_secs = ringSeconds = 20`, so Telnyx tore the B-leg down at the same
second she picked up. The ladder waited the 3s AMD-clearance cap, fail-opened
to `bridge` on a dead leg, hung up, and reported `nobody_answered`. Widening
the poll grace does not keep Telnyx from closing the leg.

## What shipped

- `decideTransferStart` (`vps/voice-bridge/src/transfer-gate.ts`): refuse
  while in-flight, 60s cooldown after exhaustion, cap 2 per call. `inFlight`
  is set synchronously in the tool-call loop **before** the async IIFE.
- `readReachOutcome` / `readReachAmd` ignore a same-attempt stamp whose
  non-empty `b_leg` is not the dialed leg. `handleReachAmd` writes `b_leg`.
  Do not change `record_reach_outcome`: letting an older attempt overwrite
  would clobber a real answer.
- `runReachLadder` takes `signal?: AbortSignal`, aborted on teardown and
  `end_call`. Returns `caller_gone` and hangs up the in-flight B-leg.
- Dial `timeout_secs = ringSeconds + ceil(REACH_AMD_CLEAR_MS/1000) + 5`
  (default 28). Poll still uses `ringSeconds`. `REACH_OUTCOME_GRACE_MS = 6000`
  plus a final read after the deadline.

Fleet redeploy of `vps/voice-bridge/` is required. Edge `telnyx-voice-call-end`
auto-deploys on main.

Related: [[voice-caller-hangup-race]], [[amd-false-negatives-and-prompt-ended]].
