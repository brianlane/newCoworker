---
name: telnyx-premium-amd-event-collapse
description: "Telnyx premium AMD events collapsed platform-side on 2026-08-25: greeting.ended extinct (last 2026-08-24T21:30:48Z), detection.ended down from ~1:1 to a trickle; our dial, config, and deploys unchanged; support-ticket evidence inside"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9cd0585e-a908-4526-b74e-e31fadb64a53
  modified: 2026-08-27T20:59:19.772Z
---

Investigated 2026-08-27. The Edge deterministic voicemail path
(`speakVoicemail` in `telnyx-voice-call-end`) stopped firing because the
Telnyx events that trigger it stopped arriving, and the break is on
Telnyx's side, not ours.

## The timeline (both from OUR data, not Telnyx's lossy logs)

`telnyx_webhook_events` (the dedup table, records every webhook received)
per day, `call.machine.premium.*`:

- Aug 12-24: detection.ended 4-8/day, roughly 1:1 with answered flow calls;
  greeting.ended 1-7/day. Healthy.
- **Last greeting.ended ever received: 2026-08-24T21:30:48Z**, in a fully
  healthy burst (4 detections + 2 greetings in ~2.5 min).
- Aug 25 onward: greeting.ended ZERO. detection.ended a trickle: Aug 26 saw
  2 of 7 answered calls (both `not_sure` at the ~30s analysis timeout),
  Aug 27 saw 2 of 3 (`machine` at ~4.5s after answer, so when it runs it
  still runs fast).

`telemetry_events` `voice_amd_verdict` vs `voice_outbound_originated`
confirms the same collapse. `voice_amd_screening` count all time: ZERO
(the ios variant's screening event has never fired once since arming).

## What was ruled out (all verified)

- **Arming**: every Aug 26-27 session has `context.flow_run` set, so every
  dial sent `answering_machine_detection: premium_ios_call_screening_detection`.
- **Our code**: no commits touched the dial path since #1428/#1475 (Aug
  17-18); nothing voice-related merged Aug 23-26.
- **Per-tenant app migration (Aug 17)**: NOT the cause. Amy's app
  3028164519999309272 ran healthy Aug 18-24. Call Control applications
  carry no AMD settings at all (AMD is per dial command), webhook URL is
  the same dispatch function as central.
- **Delivery failures**: `webhook_deliveries?filter[status][eq]=failed`
  returns zero rows for the window. Telnyx is not failing to deliver;
  it is not generating the events.

## The contract violation (ticket ammunition)

Telnyx docs: detection.ended ALWAYS arrives (worst case `not_sure` at the
30s `total_analysis_time_millis`); after a `machine` verdict,
greeting.ended arrives on beep or on greeting timeout.

- Sandy Baldwin call `v3:dcYKKPWHEUrG6F1jEe06P4pIGZxPPGEhc8RnD4WTqDSGcXF03kye7g`
  (leg `d8ea7f60-a163-11f1-9a4a-02420aef8fa1`), answered 2026-08-26T15:36:21Z,
  up 207s: NO AMD event of any kind. Direct violation.
- Roger `v3:C5saiZEaoBmiiz6j36pJTsHgsikyPIHNQOBhX61E5xRLIEazmZDeWA`
  (leg `df16ae12-a22c-11f1-8b04-02420aef8ea1`): `machine` 2026-08-27T15:35:30Z,
  leg up 25s more while the mailbox greeting played, no greeting.ended.
- Matt `v3:4yF1qaegURga0TjBfuppTvrtC5tXckUVTrEV7nqwEnil3hyfVo31cA`
  (leg `1869acc2-a23d-11f1-915d-debaecefaa94`): `machine` 2026-08-27T17:31:18Z,
  ~15s more, no greeting.ended.
- Aug 26 `not_sure` pair: `v3:aTqVgXrynX0HPLjBZH-HoO6efAA1QuA1-1ihWSjR-1cNr_sEj9D51w`
  18:57:37Z and `v3:AZ9BqFNspGhYd7sXw85RmPGBq4qRchDeMnYee5x7Cv8AgQwRyrvUFw`
  19:17:50Z, both answering machines per transcript.

Two more Telnyx-side oddities that belong in the ticket:

1. **AMD billing records nearly stopped at the per-tenant migration.**
   `detail_records?filter[record_type]=amd` shows ~1 record per armed call
   on the central connection through Aug 16 15:31Z, then only TWO ever on
   Amy's connection (Aug 20 23:01:25Z leg `117b576e-`, Aug 24 16:28:13Z leg
   `cd74ed6e-`) against ~40 delivered detection webhooks Aug 17-24. So
   billing records do NOT track invocations and cannot be used as ground
   truth for "did AMD run" (I fell for this mid-investigation).
2. **`webhook_deliveries` is a lossy log.** Session
   `1865d1f6-a23d-11f1-92de-debaecefaa94` shows only its AMD event and a
   recording.saved delivered 15 min late; its initiated/answered/hangup
   rows are absent entirely, yet we demonstrably processed them (session
   reached done, stamps written, run resumed). Absence of a row there
   proves nothing. Also `filter[occurred_at]` is silently not honored;
   filter on `started_at`.

Correlation, not proof: Telnyx ran scheduled "Programmable Voice" platform
maintenance completed Aug 26 and Aug 27 (status page), and an Aug 25
outbound-PSTN incident. The collapse begins with the first calls of Aug 25.

## UPDATE 2026-09-03: events resumed Aug 29, and prompt_ended is not the beep

Greeting and detection events returned after Aug 29. The collapse window
was Aug 25-28. Speaking on the resumed `greeting.ended result=prompt_ended`
then lost about a third of Amy's voicemails: Telnyx fires `prompt_ended` at
the first pause in the greeting, not the beep, then cancels an in-flight
speak (`cancelled_amd`) when the real beep arrives. `call_screening.detected`
can arrive AFTER `prompt_ended` (Robert, Sep 2, +31.5s after the machine
stamp); the documented order does not hold. The 25s sweep grace spoke into
that still-pending screen. Detail and the fix:
[[voicemail-beep-trigger-sep2026]].

Grace is now 40s. Edge speaks only on `beep_detected`. `voicemail_spoken`
is no longer promoted from the wall clock when the latest speak ended
`cancelled_amd` or `call_hangup` without a restart.

## Consequence chain

Under `premium_ios_call_screening_detection` a `machine` verdict is
PROVISIONAL (`amd_machine_awaiting_resolution`, telnyx-voice-call-end
~line 693): every ACTION (speak script, hang up) is deferred to a
greeting/screening event. With greeting.ended extinct, `speakVoicemail`
can never run even on calls where detection works. The model's
`voicemail_reached` tool now carries 100% of voicemails, which is why the
ad-lib fabrications ([[ai-invents-callback-numbers-on-voicemail]]) reach
leads unfiltered. Design fragility to fix separately: the awaiting state
has no timeout, and the screening event it waits for has never fired once.
Reviving `speakVoicemail` must also fix its optimistic stamp: it writes
`voicemail_spoken: true` when the Telnyx speak command is ACCEPTED (2xx,
~line 1156), not when playout completes; `call.speak.ended` only hangs the
leg up. Same accepted-vs-delivered shape PR #1672 closed on the bridge
side; the Edge side kept it only because the path was dead in practice.

## MITIGATION SHIPPED (PR #1674, merged 2026-08-27 ~21:00Z)

A 15-second pg_cron sweep (`voice-amd-resolution-sweep`; the job's SQL
gates its net.http_post on an indexed EXISTS, so idle ticks make no HTTP
call) forces resolution of a machine stamp unresolved past a 40s grace
(raised from 25s so the sweep cannot speak into a still-pending iOS
screen; Telnyx default `prompt_end_timeout_millis` is 30s):
speak the configured script or hang up scriptless legs, through the SAME
`voice_claim_voicemail_speak` claim as the greeting handler and the
model's tool, so no two paths can double-speak. `stampMachine` writes
`machine_stamped_at` once (a redelivery keeps the clock). The DIAL is
unchanged (still premium_ios; the mode swap to plain premium was declined:
the sweep neutralizes the wait-state without touching the dial, and if
Telnyx recovers, greeting events resume driving the fast path with the
sweep as a no-op backstop).

Honesty shipped with it: `voicemail_spoken` now lands only when
`call.speak.ended` reports status=completed, or via the wall-clock
plausibility fallback at hangup (`_shared/voice_voicemail_timing.ts`,
constants pinned equal to `vps/voice-bridge/src/voicemail-timing.ts` by
test). The Edge speak stamps `voicemail_speak_started_at` at accept. The
owner summary SMS renders a held claim without the stamp as "the scripted
message is being left" (bridge change, fleet redeploy required and done).

Rollout gate: `admin_platform_settings` key `voice_amd_resolution`
`{enabled, business_ids, all_businesses}`; anything missing or malformed
is OFF for everyone. Amy (`621a5b0d-…`) enrolled 2026-08-27 as the
measurement arm. Grade per
[[feedback_score_prompt_changes_against_outcomes]] with
`npx tsx debug/amd-resolution-measure.ts --business <uuid>`: it prints
per-call verdict/sweep/spoken state and raises ALARM when the sweep acted
on a live-looking transcript (the false-positive-machine stop signal; ONE
real instance means pause the rollout). Bugbot rounds worth remembering:
chained supabase-js `.or()` filters compose ambiguously (use `isdistinct`,
verified live on prod PostgREST), and `call.speak.ended` fires for
interrupted playout too (status gate required).

## How to re-check health (1 minute)

REST: `telnyx_webhook_events?select=event_type,received_at&event_type=like.call.machine*&received_at=gte.<date>` and count per day. Healthy =
greeting.ended present most days and detection ~= answered flow calls.

**How to apply:** before blaming our dial or config for missing AMD
events, pull the per-day table above; the platform has already shown it
can silently stop emitting documented events. Never treat
`webhook_deliveries` absence or `detail_records` amd rows as proof either
way. Related: [[amd-false-negatives-and-prompt-ended]],
[[ai-invents-callback-numbers-on-voicemail]].
