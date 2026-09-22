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

The fix lives in `call-integrity-lines.ts` (`NEVER_NAME_A_TOOL_LINE`,
`PLAIN_ACTION_LINE`, `END_CALL_STAY_SILENT`), used by both prompt builders,
and the ack is `stay_silent`. Do not drop BLOCKING on the phone to fix
this, and do not put extended thinking on the line: that model rejects
blocking and rejects function scheduling, and it keeps streaming audio
while tools run.

A prompt-only revert of one sentence will not reproduce the incident.
The deployed lines and the speakable ack were jointly load-bearing.
