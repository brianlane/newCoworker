---
name: nightly-red-sep8-three-unrelated-flakes
description: "Sep 8 nightly red is three unrelated flakes in two passes, not the four merges since Sep 7; companion was a judge markdown citation miss, call-promise and schedule-reschedule had no dump and lived in beforeAll"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-08T15:30:00.000Z
---

Sep 8 2026 nightly (run 34234123205, main @ d128c5f3) went red. Two
passes, different tests each pass. Do not treat them as one drift event,
and do not blame the four merges since the last green night (#1807 Clever
example-offer copy, #1811 HQ dossier, #1806 outreach send-as alias,
#1810 concurrent reach ladders). Diffstat against those tests and the
SMS prompt lines is empty.

1. **Pass 1 (13:48 UTC):** `dashboard-companion-bridge.e2e.test.ts`
   "reads the real thread and answers from it". Both in-test retries
   failed inside `judgeReply` on `grounded_in_thread` citation matching.
   The replies WERE grounded (David's Aug 11 intro, "maybe thursday",
   the Aug 13 re-intro). The companion wrapped those quoted SMS bodies
   in markdown italics (`*"hey david..."*`) and the judge copied the
   inner phrase without the asterisks, so `normalize(reply).toContain(cited)`
   failed. The dump after `judgeReply` never ran because the throw is
   inside the judge.
2. **Pass 2 (13:56 UTC):** two different files.
   - `sms-scheduled-text.e2e.test.ts` "moves the queued text to the new
     time": `Date.parse(sendAtIso)` not finite. Generation was in
     `beforeAll`, no dump of args. The sibling reminder-covered test
     failed once then passed on its Sep 4 `{ retry: 1 }` absorber
     (judge said `claims_reminder_is_set=true` on "We actually send an
     automatic reminder out an hour before"). Local: 0 fail / 5 the
     same afternoon.
   - `sms-call-promise.e2e.test.ts` "turn 4 never promises that the
     assistant will place a call": `promises_sender_call` true. No
     reply in the log. Pass 1 had passed this file. Local: 4 pass / 5,
     then turn 3 failed on "Our team can certainly call you. What is
     the best number to reach you at?" The judge scored that reply
     TRUE **10/10** on the old wording. TEAM MEMBER was not enough:
     "our team" reads as the sender, the same first-person-plural hole
     TEXT_QUESTIONS closed on 2026-07-27. A/B (6 draws x 4 cases): old
     wording 6/6 TRUE on that handoff, new wording 0/6, and 6/6 TRUE
     on both first-person violations.

**Fixes:** strip `*` and backticks in `normalizeForCitation` (hermetic
pin of the two captured companion replies); dump the live reply if
`judgeReply` throws; convert call-promise and the schedule reschedule
into `{ retry: 1 }` tests that dump reply, calls, and verdict; rewrite
the call-promise judge question with the plural-voice clause (lockstep
in judge-calibration, pin the captured reply). No coworker prompt
edit. See [[project_nightly_red_sep4_two_flakes]],
[[project_translator_interpret_flake]],
[[project_e2e_judge_question_polarity]],
[[feedback_score_prompt_changes_against_outcomes]].
