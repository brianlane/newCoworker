---
name: ai-invents-callback-numbers-on-voicemail
description: "Outbound AI voicemails ad-lib a sign-off with a FABRICATED callback number before calling voicemail_reached; 13 wrong numbers given to Amy's leads in 45 days"
metadata: 
  node_type: memory
  type: project
  originSessionId: f92ec33f-e800-4569-9e1b-d63077b2e8c1
  modified: 2026-08-25T19:44:49.587Z
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

**Still unverified in the wild as of 2026-08-25 21:00Z**: zero calls placed
since the redeploy, and her cadence dials in the morning Arizona time. Re-run
`npx tsx debug/voicemail-number-audit.ts --business 621a5b0d-c2ad-449f-9d74-9d50e7b27fa3 --since 2026-08-25T20:40:00Z`
and read the CALL COUNT next to the verdict: zero calls is no evidence, not a
pass.

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
