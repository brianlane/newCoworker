---
name: amd-false-negatives-and-prompt-ended
description: Telnyx premium AMD calls voicemails human_residence/human_business, and prompt_ended fires for ordinary voicemail greetings too
metadata:
  type: project
---

Two separate voicemail-detection facts, both learned the hard way on
2026-08-17 (Amy Laidlaw's account).

**1. Premium AMD false-negatives on personal greetings.** It returned
`human_residence` for Jim Inderberg's mailbox and `human_business` for a Mesa
seller's. A personal outgoing greeting is one human voice talking, which is
exactly what those classes describe. This is not fixable in our code.

The cost is NOT the awkward audio, it is the flow outcome: an AI call resolves
its outcome from whether a machine was detected, so an undetected voicemail
records `call_outcome: "answered"` / "spoke with them". The Needs Follow Up
cadence gates its follow-up text on `call_outcome equals no_answer`, so the
lead gets no text, no further calls, and the run parks for 3 days awaiting a
reply that cannot come. Three leads died this way before it was noticed.

Mitigation (PR #1428): a `voicemail_reached` tool the assistant calls when IT
hears a recording. It stamps machine_detected + the transcript badge (so the
outcome and the call page are right) and, when the step configured a
voicemailTemplate, claims the shared `voice_claim_voicemail_speak` lock and
hands the script back to read. Prompt-layer detection is best-effort: on one
call the model never called end_call at all, so the deterministic AMD path
stays primary.

**2. `prompt_ended` is NOT exclusive to Apple call screening.** Under
`premium_ios_call_screening_detection` Telnyx fires it whenever the prompt
following a machine verdict ends WITHOUT a beep, which an ordinary voicemail
greeting does. Treating it as "a live person is screening" cancelled a CORRECT
machine verdict (PR #1412 regression, fixed in #1428). Only a real
`call.machine.premium.call_screening.detected` proves a person is deciding.
`classifyGreetingEvent` in `_shared/voice_amd.ts` owns that rule now.
Only `beep_detected` is `machine_resolved` (speaking on `prompt_ended` is
the cancelled_amd hangup; see [[voicemail-beep-trigger-sep2026]]).

**How to apply:** never trust a single voicemail signal, and never assume an
event name means what its docs' prose implies. Related:
[[homelight-claim-click-silent-noop]], [[voice-bridge-excluded-from-root-tsc]].
