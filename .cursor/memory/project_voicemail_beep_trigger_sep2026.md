---
name: voicemail-beep-trigger-sep2026
description: "Speaking on prompt_ended lost about a third of Amy's voicemails (cancelled_amd hangup); the Sep 1 integrity email was a muted-turn false alarm and a mid-word clip"
metadata:
  type: project
---

Investigated 2026-09-01 through 2026-09-03 after a call-integrity email named
call `9b03d39d` (Jon, Amy Laidlaw, 2026-09-01 16:17Z).

## The email was a false alarm, and it was clipped

Telnyx premium AMD returned `human_business` (the routine personal-greeting
false negative). The model called `voicemail_reached` at +9.7s. The bridge
muted (`muted_chunks: 34`). The mailbox beeped ~+15s, recorded silence, said
"I couldn't hear you. Please try again", beeped again ~+31s. The sweep spoke
at stamp+28s into the second recording window. Lucky, not designed.

`talked_to_recording` counted 3 assistant turns: "Hi Jon," (heard), a muted
model turn (never heard), and the `[Voicemail]` badge (code-written). Only
one utterance was heard. `formatCallIntegrityAlert` clipped every detail at
160 chars, so the quote died mid-word inside an open quote (`"...or pre`).

## The real voicemail bug (Telnyx webhook_deliveries, Aug 29 to Sep 2)

`classifyGreetingEvent` treated `prompt_ended` as `machine_resolved`. Telnyx
fires that at the **first pause** in the greeting, not the beep.

- 5 calls lost to `cancelled_amd`: we spoke 1-3s after `prompt_ended`; the
  real beep arrived 7-22s later; Telnyx cancelled the speak;
  `handleSpeakEnded` hung up anyway. Nothing recorded. 4 of 5 still stamped
  `voicemail_spoken: true` via the wall-clock promote (the leg stayed up
  while Telnyx kept listening).
- `D91Gt`: `speak.ended completed` 0.6s after a 190-char speak. Stamped
  delivered. Not plausible.
- `ac0P3P` (Robert, Sep 2): `prompt_ended` at +19.9s was iPhone screening;
  `call_screening.detected` arrived +31.5s **after** we had stopped the
  stream and started reading the script into the screening prompt, then hung
  up on a live person. Telnyx's documented order (screening before
  prompt_ended) does not hold. We do not send
  `answering_machine_detection_config`; Telnyx default
  `prompt_end_timeout_millis` is 30s.
- 8 calls waited for `no_beep_detected` at +24-26s (inside the screening
  window). 2 hung up on silence as we started speaking.
- 2 calls with no greeting event: mailbox beeped ~stamp+8s; one hung up on
  silence at stamp+23s, before the old 25s sweep grace.
- 4 `human_*` false negatives: no Telnyx beep detection; only model tool +
  late sweep. `ZyntOh` spoke into the post-recording options menu.
- 1 clean delivery: `QiIXFD`, `beep_detected` at +2.5s.

Of 21 calls the measure script counted as delivered, at least 7 were not.
Only the beep-triggered one is provably right.

## What shipped

- Edge speaks only on `beep_detected`. `prompt_ended` / `no_beep_detected` /
  unknown results are `noted`. The machine stamp stays (Jennifer Kline: do
  **not** return `screening_person` without a real screening event).
- `classifySpeakEnded`: re-speak once on `cancelled_amd` or implausibly
  short `completed`; hang up only on plausible completed. The retry is
  compare-and-set via `voice_claim_voicemail_retry` (two in-flight
  speak.ended handlers cannot both speak). A redelivered first-speak
  ended whose `occurred_at` is before the retry's `started_at` is ignored
  so it cannot hang up the retry. A legacy `voicemail_spoken` stamp with
  no start time hangs up and does not retry.
- `resolveEdgeVoicemailSpoken` refuses the wall-clock promote on
  `cancelled_amd` / `call_hangup` without a restart.
- Sweep grace 25s → 40s (past the 30s default timeout + Robert's +31.5s).
- Bridge Goertzel beep detector on uplink L16 16 kHz. Speaks only after
  `voicemail_reached` OR a machine-phrase transcript, never on Telnyx
  `machine_detected` alone (that stamp is provisional under iOS screening).
- `[Muted]` prefix on muted model turns; hidden on the call page. Integrity
  skips `[Muted]` and `[Voicemail]`. Alert clip is word-boundary + closed
  quote.

**Post-merge:** `tsx debug/redeploy-voice-bridge.ts --all` (dry-run first).
Edge functions auto-deploy on main; the beep detector does not.

Grade with `npx tsx debug/amd-resolution-measure.ts --business <uuid>`:
it now prints `trigger`, `ended`, and Telnyx `cancelled_amd`.

Related: [[telnyx-premium-amd-event-collapse]],
[[amd-false-negatives-and-prompt-ended]],
[[ai-invents-callback-numbers-on-voicemail]].
