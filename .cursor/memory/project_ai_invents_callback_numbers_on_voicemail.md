---
name: ai-invents-callback-numbers-on-voicemail
description: "SOLVED 2026-08-29 (#1742): the voicemail script NEVER reached the model (tool response dropped the field), so it reconstructed messages and fabricated 16 callback numbers; fixed by payload pin + deterministic TTS delivery + spoken-number firewall (Telnyx clear)"
metadata: 
  node_type: memory
  type: project
  originSessionId: f92ec33f-e800-4569-9e1b-d63077b2e8c1
  modified: 2026-08-27T21:20:08.206Z
---

Found 2026-08-25 from Amy's own question ("whose phone number is this? I
thought they usually put the AI phone number in there"), about a voicemail
telling lead Tami Nelson to call **480-256-2580**.

## What is actually happening

The authored script is fine and IS loaded. Every `voicemailTemplate` on her
account says **602-695-1142**, and `voice_handoff_sessions.context.voicemail.script`
carried the correct rendered text on every call checked. Nothing in any flow,
config, roster or contact row contains a 480 number.

**The model speaks BEFORE calling `voicemail_reached`.** At the beep it
ad-libs a natural sign-off, and because no number is in its persona or
context note, it FABRICATES a plausible Phoenix-area one. Then, sometimes, it
reports the recording, gets the real script back and reads it correctly, so
the mailbox ends up holding two messages with the wrong number first.

Two shapes, both observed:

- **Tami Nelson (2026-08-25, call `78mC5F7p`)**: ad-lib with 480-256-2580,
  THEN `[Voicemail]` turn with the correct 602-695-1142.
  `voicemail_spoken: true`.
- **Isiah Perez (2026-08-23, call `ubx54CyO`)**: ad-lib with 480-405-7790 and
  nothing else. `voicemail_spoken` never set, so the approved message was
  never left at all.

## Blast radius (45 days, Amy only)

77 outbound calls, 54 reached a machine:

| what the lead heard | count |
| --- | --- |
| WRONG number only | 2 |
| wrong, then the correct one | 11 |
| correct only | 15 |
| no number spoken | 26 |

**13 distinct fabricated numbers**, each spoken once, mostly 480 but also
602 (`480-205-2423`, `480-245-4200`, `480-256-2580`, `480-264-0775`,
`480-405-7790`, `480-442-2441`, `480-454-1065`, `480-454-7264`,
`480-725-3600`, `480-788-4545`, `602-362-4030`, `602-566-8257`,
`602-737-0230`). These are plausible live Phoenix numbers, so real strangers
may be receiving misdirected callbacks. Do NOT dial them to check.

## Why the existing guards did not hold

`OUTBOUND_VOICEMAIL_TOOL_LINE` already says to call `voicemail_reached`
"BEFORE YOU SAY ANYTHING ELSE" and not to improvise, and
`intakeSystemInstruction` already bans reading briefing details into a
mailbox. Neither forbids SPEAKING A NUMBER THAT IS NOT IN THE SCRIPT, and
ordering instructions alone are not holding against the model's instinct to
answer a greeting politely.

The SMS side already treats this class as real: `sms-call-promise.e2e.test.ts`
asserts a reply matches no `\d{3}[ .-]?\d{3}[ .-]?\d{4}`. Voice had no
equivalent.

## SHIPPED 2026-08-25 (PR #1612), live on all 5 boxes

`NO_INVENTED_CONTACT_LINE` in `vps/voice-bridge/src/call-integrity-lines.ts`,
pushed by BOTH persona builders. Framed as SOURCE, not silence: a number,
email, website or address may be spoken only if it is written character for
character in the instructions, OR the person on this call just said it and
you are repeating it back. Fabrication is the case where it came from
neither. Interpreter mode carved out explicitly (relay what was said, never
fill in what was not), matching ONE_VOICE_LINE, because a persistent NEVER
outranks a mid-call cue and a blanket ban gutted translator calls in review.

Also removed the clause that CAUSED it: RECORDED_SYSTEM_LINE told the model
its voicemail should say "how to reach you" without supplying a number. That
is now conditional on the script actually containing one.

**Verification is by transcript, not by test.** Production voice runs
`gemini-3.1-flash-live-preview` over the realtime audio API, which no test
tier here can drive. I wrote a live e2e first, it PASSED against the unfixed
prompt, and I deleted it: the text tier drives a different model that already
stays silent at a beep on the OLD prompt (probe replies came back empty). A
green text test proves nothing about the live one. See
[[feedback_prove_prompt_fixes_against_deployed]].

`debug/voicemail-number-audit.ts` (PR #1614) is the verification: it reads
what the assistant actually said and flags any contact number that came from
neither the allowlist nor the caller. **Building the allowlist is the whole
difficulty** and Bugbot found four holes across two rounds, every one a FALSE
POSITIVE that would have said the fix failed. Legitimate sources are:
`businesses` phone-ish columns, `notification_preferences.phone_number`,
`business_telnyx_settings` (`telnyx_sms_from_e164`, `forward_to_e164`),
`telnyx_voice_routes.to_e164` (the line calls ARRIVE on, distinct from the
SMS-from number in general and the sharpest miss, since it IS the AI number
Amy expected), `ai_flow_team_members`, and numbers written into flow
definitions matched as E.164 or separated 3-3-4 but deliberately NOT as bare
10-digit runs (those are epochs in flow JSON). Plus, per call,
`caller_e164` / `forwarded_to_e164`. Amy's allowlist: 12 numbers.

## VERIFIED 2026-08-27: the fix is NOT holding

First two mornings of dialing after the redeploy: 9 calls, 8 reached a
machine, and 2 of those 8 ad-libbed a FABRICATED callback number anyway,
the same ~25% rate as before the fix:

- Sandy Baldwin, 2026-08-26 15:36Z, call `68ca8cdb`: **480-269-7977** (the
  call the first-ever call-integrity sweep email flagged).
- Matt, 2026-08-27 15:30Z, call `5b335fc8`: **480-331-9100**.

Do NOT dial either number. The box was verified running #1612 at the time
(`/opt/newcoworker-repo` HEAD `9db041d`, container up since the redeploy),
so this is the model disobeying a deployed rule, not a stale deploy. Per
[[feedback_score_prompt_changes_against_outcomes]], the next fix must be
deterministic, not a fourth prompt line.

Caveat on "same ~25% rate as before": the comparison is confounded by the
AMD collapse date ([[telnyx-premium-amd-event-collapse]]). Pre-Aug-25, some
machine calls were handled by the deterministic Edge speak before the model
could ad-lib; post-collapse every voicemail is model-driven, a strictly
harder condition. The conclusion stands (the prompt line alone is
insufficient), but do not read the two rates as a controlled A/B.

**Three structural facts learned from the same investigation:**

1. **Telnyx premium AMD events collapsed on 2026-08-25, platform-side.**
   Corrected 2026-08-27 after a full recount: events were healthy and
   roughly 1:1 with answered calls through Aug 24 (last greeting.ended
   2026-08-24T21:30:48Z), then greeting/beep went to ZERO and detection to
   a trickle (Aug 26-27: detection on 4 of 10 answered calls, two of them
   `not_sure` at the 30s timeout). Arming, app config, deploys, and
   delivery failures are all ruled out; evidence and ticket draft in
   [[telnyx-premium-amd-event-collapse]]. Consequence unchanged: the Edge
   `speakVoicemail` path (`telnyx-voice-call-end`), designed as the
   deterministic primary, cannot fire (no greeting event ever resolves the
   provisional machine verdict), so the model's `voicemail_reached` tool
   carries every voicemail.
2. **`voicemail_left: true` overstates.** The `[Voicemail]` transcript turn
   is a BADGE written when the tool hands the script over, and
   `voicemail_spoken` is stamped by the `end_call` handler, so both land
   even when the audio physically cannot have played: on Sandy's call OUR
   leg hung up at :48.96, the mailbox had stopped recording at :45, badge
   written :49.9. Her mailbox holds the AI's greeting plus ~3 minutes of
   silence; the scripted message with the correct 602-695-1142 never went
   out. Brett's call (13s answered-to-hangup) and Roger's (greeting still
   playing at hangup) show the same impossible timing.
3. **The daily call-integrity sweep misses the common shape.** It needs 3+
   assistant turns with every caller turn machine-like; the typical
   one-line ad-lib before the badge is 2 assistant turns, so Matt's
   invented-number call will never be flagged. Only
   `debug/voicemail-number-audit.ts` (manual) catches fabrications.

Fleet check 2026-08-27: only 4 non-Amy calls in 7 days, none fabricated;
this is an Amy-volume problem today.

## SHIPPED 2026-08-27, structural fixes for all three facts

- **PR #1671** (edge, auto-deployed): the daily call-integrity sweep gained
  an `invented_contact_number` rule sharing the audit script's allowlist via
  `_shared/call_integrity.ts` (fail-open on any source-query error). First
  live run flagged Matt's 480-331-9100 call and emailed the admin inbox, so
  fabrications now page within a day instead of waiting for a human to read
  transcripts. The scheduled 13:40Z run dedupes anything a manual run
  already reported.
- **PR #1672** (vps/voice-bridge, fleet-redeployed): `voicemail_left` stops
  overstating. `voicemail_reached` is refused when end_call was requested or
  rides the same model turn (no claim, no badge, no stamp;
  `voice_bridge_voicemail_after_end_call` diag), and `confirmSpoken` stamps
  only when the line was up long enough after the script handover for half
  the read (`voicemail-timing.ts`, window anchored to the FIRST end_call's
  hangup moment per Bugbot's #1672 finding;
  `voice_bridge_voicemail_cut_short` diag counts refusals, baseline
  matters: a spike means reads are being cut, not that the guard is wrong).
- **PR #1674** (edge + migration + bridge alert copy, all deployed): the
  deterministic answer. A 15s sweep forces resolution of a machine verdict
  25s after the stamp (speak the script through the shared claim, or hang
  up scriptless legs), so a verdict-backed voicemail no longer depends on
  the model at all, and `voicemail_spoken` is now stamped on completed
  playout or wall-clock plausibility, never on command accept. Dark-shipped
  behind `voice_amd_resolution`; Amy enrolled for measurement. Full detail
  in [[telnyx-premium-amd-event-collapse]]. Scope limit: the sweep only
  helps calls where Telnyx delivered a verdict (about half right now);
  verdict-less machine calls (Sandy's shape) remain model-only until the
  Telnyx ticket resolves.

## 2026-08-29: the REAL root cause, found on the failure that beat every fix

Call `5e325829` (Charisa Deremiah, Clever seller): the model did everything
right, `voicemail_reached` BEFORE speaking (verdict at 3.7s, tool at 5s,
claim won), then spoke a compressed REWRITE with an invented "offer came
through" and fabricated 480-400-0588, and ended the leg at 11s. Its claim
had stood the #1674 sweep down (claimed legs leave the sweep's queue), so
every deterministic layer watched the model betray the read.

**The script never reached the model. Not once, on any call since the tool
shipped (#1428, Aug 17).** `sendToolResponse` forwarded only
ok/detail/message/data; the handler passed `script` through an object
SPREAD, which bypasses TypeScript's excess-property check, so it compiled
and was dropped on the wire. The tool-response diag proves it per call:
`data_type: "none", data_keys: null`. The model held "read this message
aloud word for word" + a declaration promising `script`, and no script, so
it reconstructed a voicemail from its briefing, which never contains a
callback number. Every "correct" script read in old transcripts was the
`[Voicemail]` BADGE turn (code-written) or predates #1716, when the script
text still sat in the persona. #1716 removed that fallback when the tool
exists, leaving the inbound path fully dependent on the dropped field.

**Lesson: an excess object property passed through a spread compiles and
vanishes.** When a tool contract promises a field, pin the wire payload
builder with a test that walks every field of the source type
(`vps/voice-bridge/src/tool-response-payload.ts` +
`tests/voice-bridge-tool-response-payload.test.ts`).

## SHIPPED 2026-08-29 (PR #1742): script restored, and the wire stops trusting the model

- **Payload pin**: `script`/`alreadyBeingLeft` now reach the wire; test
  walks every ToolResult field. Fixes reads for ALL tenants incl. the
  #1716 inbound transfer path.
- **Deterministic voicemail delivery** (outbound + authored script + tenant
  enrolled in `voice_amd_resolution`): `voicemail_reached` becomes a pure
  verdict. Bridge stamps `machine_stamped_at` itself when Telnyx never did,
  does NOT claim, MUTES model audio for the rest of the call, flushes the
  Telnyx queue, refuses model `end_call` for 120s
  (`voicemail-mode.ts`). Delivery: greeting.ended handler at the beep, else
  the #1674 sweep at stamp+25s, Telnyx TTS through the shared claim,
  verbatim BY CONSTRUCTION. Tool declaration and persona line switch to
  report-and-stay-silent in this mode (never both procedures, #1716
  lesson).
- **Spoken-number firewall** (`voice_spoken_number_guard` platform-settings
  gate, fail-OFF): output transcription scanned against a per-call
  allowlist = everything the bridge fed the model (instruction, cues via a
  sendRealtimeInput tap, tool responses, brief) + caller-spoken numbers +
  party/configured numbers. Violation: Telnyx `{"event":"clear"}` flushes
  the queued not-yet-played audio (generation runs ~2x realtime, digits are
  still queued), rest of turn dropped, corrective cue on live legs (max 2),
  suppression recorded on session context. Extraction is a lockstep copy of
  the sweep's, pinned by `tests/spoken-number-guard-lockstep.test.ts`.
- **Persona names THE callback number** from the authored script (every
  fabrication happened where the model held none).
- **Sweep reconciliation**: a firewalled number reports as
  `voice_call_integrity_blocked` (level warn, tail line on the email),
  never a failure page for audio nobody heard; deduped with the failure
  event.

Rollout: fleet redeploy required for the bridge; Amy enrolled in
`voice_spoken_number_guard` post-deploy (deterministic mode arms from her
existing `voice_amd_resolution` enrollment). Grade with transcripts +
`debug/amd-resolution-measure.ts`; watch `voice_bridge_spoken_number_suppressed`,
`voice_bridge_voicemail_deterministic`, `voice_bridge_end_call_deferred_for_voicemail`,
teardown `muted_chunks`. Known limits: digit-form transcriptions only
(words-spelled-out slips the regex), and a badly lagging transcription
could lose the race on a long turn.

## Original fix direction (superseded by the above)

Prompt-side, in `vps/voice-bridge/src/intake.ts`: an explicit never-say-a-
number-that-is-not-in-your-instructions rule on the outbound persona, and
make the ad-lib itself unnecessary by stating that a recording gets the tool
call and nothing else. Prove it against the DEPLOYED prompt with a live e2e
that asserts no fabricated digits, per
[[feedback_prove_prompt_fixes_against_deployed]] (one-line reverts
false-negative here; the rules are jointly load-bearing). Remember
`vps/voice-bridge` needs its own tsc and a fleet redeploy
([[project_voice_bridge_excluded_from_root_tsc]],
[[project_fleet_redeploy_check]]).

Related: [[project_amy_policies]] (her voicemails must carry 602-695-1142),
[[project_amd_false_negatives_and_prompt_ended]].
