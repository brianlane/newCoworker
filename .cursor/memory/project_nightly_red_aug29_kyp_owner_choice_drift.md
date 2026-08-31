---
name: nightly-red-aug29-kyp-owner-choice-drift
description: "Aug 28-29 nightly reds: three nights, three separate causes; the Aug 29 kyp owner-choice failure is live-model drift (~40% local repro), NOT a code regression, and the choice contract is prompt-only"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2a05e658-5ffd-4935-a372-d5572a3a0ba9
  modified: 2026-08-29T16:40:22.584Z
---

Three consecutive red nightlies (Aug 28-29 2026) had three UNRELATED causes.
Do not treat them as one drift event:

1. **Aug 28 20:58 run** (ab23efd6b): `clever-seller-name` "amy"/"pamela" was
   the KNOWN #1701 US-spelling-line regression (measured 2/10), fixed same
   day by #1715; `hq-inbox-classify` live-outage was the documented 11/12
   boundary, hardened by the same #1715. Both passed Aug 29.
2. **Aug 28 22:11 run** (aa995e5e9): `translator-interpret`, the known
   79/80 no-retry flake; absorber shipped in #1720 (after that run). See
   [[translator-interpret-flake]].
3. **Aug 29 run** (24bee8b38): `kyp-owner-sms-operator` scenario 2 "commits
   nothing before the owner chooses". The model called send_sms on round 1
   instead of presenting direct-text vs run-automation. 3 of 4 CI rolls
   failed (invocation 1: fail then pass; invocation 2: fail, fail).

**The Aug 29 failure is NOT a code regression.** Verified: every
model-visible input is unchanged between the passing night (aa995e5e9) and
failing night (24bee8b38): OWNER_PREAMBLE, SMS_SURFACE_BLOCK, the test file,
context-blocks, gemini-chat, datetime_line, judge. Only two token-level
perturbations existed: (a) the date line (Fri vs Sat, anchored to now), and
(b) `update_notification_preferences` gained 4 boolean params
(telegram/teams/google_chat/push_urgent) because action-tools.ts imports
NOTIFICATION_TOGGLE_KEYS from preferences-tool.ts, which #1717/#1722-24
extended. Lesson: "action-tools.ts unchanged" is not "tool declarations
unchanged"; diff the import closure.

**#1728 (schedule_text) is proven irrelevant to this surface**: the tool has
no dashboard twin (registry key "sms" only, rowboat-gates.ts comment says
so), and its prompt change edited SMS_GROUNDED_ACTIONS_LINE, consumed only
by the customer-facing sms-inbound-worker. The owner operator imports only
NO_EM_DASH/US_SPELLING lines from sms_prompt_lines.ts.

**Local measurement (Aug 29 ~15:30 UTC, sha 24bee8b38, temp 0)**: 5 runs of
the scenario-2 test, 2 red (both in-test attempts committed early), so at
least 4 bad rolls out of at most 12. Historical base rate: this draw was
seen ONCE ever (PR #729) and the nightly was green Aug 19-26. The
early-commit rate on this scenario genuinely rose, i.e. gemini-3.7-flash
moved, or we are in a bursty variance window (the translator lesson: rates
are bursty, measure and say when you measured; do not conclude from one
window).

**The choice contract is prompt-only, no code gate.** Four prompt sites
carry it: OWNER_PREAMBLE "PRESENT YOUR OPTIONS, THEN DO WHAT THE OWNER
PICKS" (src/lib/owner-surfaces/preambles.ts:44), SMS_SURFACE_BLOCK's
"ask ONE clear question" line (turn-surfaces.ts:87-90), the list_aiflows
tool description ("OFFER it as an option... let the owner choose",
action-tools.ts:410-413), and the list result note
(manual-run-tool.ts:106-108). run_aiflow refuses disabled flows in code;
nothing blocks send_sms. If the elevated rate persists across windows, the
fix is a scored prompt hardening
([[feedback_score_prompt_changes_against_outcomes]]), not a hunch edit.

Production impact while elevated: on the owner-SMS surface the coworker may
do the asked-for thing immediately (text the contact) instead of offering
the matching enabled automation first. Wrong per contract, but the sent text
is what the owner asked for; severity is UX/contract, not harm.
