---
name: live-transfer-amd-blindspot
description: "A partner live transfer is invisible to carrier AMD: the partner bridges the client's own line into the call we answered, so there is no leg to detect on; 5 of 8 HomeLight transfers reached the seller's mailbox and none were recorded"
metadata:
  node_type: memory
  type: project
---

Found 2026-08-28 reviewing Amy's call `dbd44742` (Rhonda J.), then measured
across every HomeLight live transfer on record.

## Why AMD can never see these

HomeLight calls US from `+14159851909`, we press 1, and then THEY dial the
seller and mix her audio into the inbound call we already answered. Telnyx
sees one inbound leg. We only arm `answering_machine_detection` on legs we
originate (`telnyx-voice-originate`) or transfer out
(`telnyx-voice-inbound` ~line 608, `telnyx-voice-call-end` ~line 427,
`reach-teammate`). There is nothing to arm here, and there never was.

This is NOT the Aug 25 premium-AMD collapse
([[telnyx-premium-amd-event-collapse]]): no event was lost, none was ever
generated. Do not go looking for `call.machine.*` on these calls.

## The measurement (all 8 live transfers ever, Amy is the only tenant)

5 of 8 landed in the seller's mailbox. Seconds the AI kept talking after its
first word: Aug 11 = 10, Aug 14 = 86, Aug 16 = 228, Aug 24 = 26, Aug 28 = 51.
One reached a live person (Aug 7). One never cleared the partner IVR at all
(Jul 30: ten repeats of "press one to agree", never connected, STILL OPEN).

ALL EIGHT carried `answering_machine_result: null` and
`voicemail_left: false`.

## The trap: the persona was never the gap

`INBOUND_VOICEMAIL_RECOGNITION_LINE` and `inboundVoicemailMessageLine` have
shipped on this persona since Aug 16, and the model USED them (Aug 24 read
the approved message verbatim; Aug 28 was midway through it when the leg
dropped). What was missing was anywhere to PUT the verdict, so a mailbox
settled on the record as an ordinary conversation and the owner alert said
"I captured this on the call" under an empty capture.

Worse, the two rules competed. `inboundVoicemailMessageLine` is a COMPLETE
procedure that never reports the recording, and it lands EARLIER in the
prompt than the tool rule, so adding the tool alongside it changes nothing:
the model keeps taking the older, unstamped path. Bugbot caught this on
PR #1716 after I had already talked myself past it. **When you add a tool to
carry a verdict, delete the prompt path that reaches the same outcome
without it.**

## SHIPPED 2026-08-28 (PR #1716, fleet-redeployed to all 5 boxes)

- `voicemail_reached` now registers on an IVR-gated inbound takeover, and
  hands back `inboundVoicemailScript` (one source shared with the persona
  rule, so tool answer and prompt cannot drift).
- The direct-read line is now the FALLBACK, shipped only when no tool exists.
- Guarded against ending a referral mid-menu: the tool is refused until
  `acceptPressCount > 0`. NOT `acceptPressed`, which is claimed
  synchronously before the Telnyx request is sent and cleared only after a
  failed press returns, so it reads true through the whole unaccepted
  window (Bugbot). Plus `batchRequestsAcceptPress` for the same-turn pair,
  mirroring `batchRequestsEndCall`. Diagnostic:
  `voice_bridge_voicemail_before_accept`.
- `voicemail_left` is written from the bridge's `confirmSpoken` for these
  calls: the edge's `decorateTranscriptForVoicemail` runs ONLY inside the
  outbound `flow_run` branch, so inbound legs never got it.
- The owner alert stops claiming a capture when the line went to voicemail.

Capability condition must stay `hangupApiKey && intake.ivrGate`, matching
the bridge's own `ivrGate = opts.dtmf && opts.intake?.ivrGate`. If they
disagree the tool arms with BOTH the carve-out and the pre-accept refusal
off, the one combination that can kill a referral.

## Pre-call brief window

Raised 15 to 30 minutes in the same PR. Rhonda's alert missed by 13 seconds
(text 15:40:02Z, transfer 15:55:16Z). Text-to-transfer delay across the 8:
0.8, 0.8, 0.9, 2.9, 12.2, 15.2, 19.2 min, plus one with no alert at all.
Widening CANNOT turn a right brief into a wrong one, because the reader
takes the NEWEST match, so extra reach only supplies a candidate where there
were none. Replaying all 8 at 15/20/30/60 min picked the same lead every
time; closest two different-lead alerts ever = 19.1 min apart.

**How to apply:** on any partner live-transfer integration, assume the
person you are bridged to may be a mailbox and that no carrier signal will
tell you. Related: [[ai-invents-callback-numbers-on-voicemail]],
[[amd-false-negatives-and-prompt-ended]], [[homelight-portal-traps]].
