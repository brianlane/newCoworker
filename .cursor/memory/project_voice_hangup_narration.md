---
name: voice-hangup-narration
description: Hangup speech named the tool because the prompt said to explain it, and the ack said "ending call"
metadata:
  type: project
---

## project-voice-hangup-narration

HQ inbound call f76c30c0 (2026-09-22, owner recognized as Brian) ended with
"Calling the end call tool now" and then "Final check complete, hanging up
now." Two causes, both on every persona:

- The tool paragraph said to explain in plain language before calling a
  tool. Staff had no example. Customer had "Let me pull up openings on
  Thursday, one moment." Neither carved hangup out, and both share the
  `end_call` paragraph, so a customer is not spared.
- The bridge acked `end_call` with `detail: "ending call"`. The model
  paraphrased that into a second line after the goodbye.

The fix lives in `call-integrity-lines.ts`. `PLAIN_ACTION_LINE` is the
plain sentence for a lookup, booking, text, or transfer, and it still
tells the model to speak `startLocal`, `existingStartLocal`, and
`sendAtLocal`. `END_CALL_STAY_SILENT` is the live-person goodbye only:
that turn's only tool call is `end_call`, and a recording follows its own
rule instead of adding a goodbye. The ack is `stay_silent`. Do not spread
the silence rule onto other tools.
Do not drop BLOCKING on the phone to fix this, and do not put extended
thinking on the line: that model rejects blocking and rejects function
scheduling, and it keeps streaming audio while tools run.

A prompt-only revert of one sentence will not reproduce the incident.
The deployed lines and the speakable ack were jointly load-bearing.
