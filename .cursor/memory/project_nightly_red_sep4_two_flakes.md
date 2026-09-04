---
name: nightly-red-sep4-two-flakes
description: "Sep 4 nightly red is two unrelated low-rate flakes in one night, not the Stripe/zod bump; kyp regex was over-specified, reminder-covered needed a retry absorber"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-04T15:45:00.000Z
---

Sep 4 2026 nightly (run 33879483886, main @ 957d6e1a) went red. Two
passes, 209/210 each, a DIFFERENT test each pass. Do not treat them as
one drift event, and do not blame the one merge since the last green
night (#1793 Stripe pin + zod 4.5 + mcp-bridge schema sanitizer).
Neither failing test sees that change: kyp's tool declarations are
hand-written literals in action-tools.ts, and sms-scheduled-text
renders from deploy-client.sh via renderWorkflowSeed.

1. **Pass 1 (13:42 UTC):** `sms-scheduled-text.e2e.test.ts` "an automatic
   reminder already covers the call" / claims_reminder_is_set=true. The
   sibling /already|automatic/ assertion passed, so the reply mentioned
   the existing 60-minute reminder. The reply text was NOT in the log
   (the assertion had no message argument). This block had no retry.
2. **Pass 2 (13:48 UTC):** `kyp-owner-sms-operator.e2e.test.ts` scenario 2
   failed both in-test attempts on the LAST assertion only. Round 1
   committed nothing and presented both options. Round 2 called
   run_aiflow on the right flow, no send_sms. The replies were:
   - "i just triggered your "booking confirmation text (calendly)"
     automation for uday nandam. you can follow the run at
     /dashboard/aiflows."
   - "i ran the ... automation ... it starts in about a minute, and you
     can track it at /dashboard/aiflows."
   "starts" is not "started"; "triggered"/"ran" were not in
   /running|started|enqueued|on it/. This is a test over-specification,
   not a contract break, and it is NOT the Aug 29 early-commit drift
   ([[project_nightly_red_aug29_kyp_owner_choice_drift]]).

**Local measurement (Sep 4):** reminder-covered 1 fail / 6 at 15:22 UTC,
then 0 fail / 10 at 15:40 UTC (every passing draw: one schedule_text
without confirmed=true, then an ask). A/B of the shipped judge question
vs a narrowed wording, 4 draws each on those passing replies plus a
true violation ("I've scheduled your reminder text for 6:30..."), scored
4/4 both arms. Do not rewrite the question. Same lesson as
[[project_translator_interpret_flake]]: the rate is bursty; a ~1-in-6
wobble with no in-test retry takes the nightly red; one retry is the
absorber, and dumping reply + calls + verdict on the next miss is what
tells judge vs model.

**Fixes shipped the same day:** widen FLOW_RAN_CONFIRMATION (and pin the
two captured replies so the old regex cannot silently return); convert
the reminder-covered block to one `{ retry: 1 }` test that dumps reply,
calls (confirmed, sendAtIso), and judge verdict on failure. No prompt
edit. See [[feedback_score_prompt_changes_against_outcomes]].
