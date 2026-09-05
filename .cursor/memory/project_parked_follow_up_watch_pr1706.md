---
name: parked-follow-up-watch-pr1706
description: "PR #1706 (remove the #1702 parked follow-up mechanism) is held open on an empirical question the daily follow-up-park-watch answers; the 9am check is a Claude Code routine ported to a Cursor Automation via the skill file; Sep 5 read: 8 days, zero parked, zero self-send"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-05T04:00:00.000Z
---

Three PRs on one thread, and one is deliberately NOT merged:

- **#1702** (merged Aug 28 2026 18:11 UTC) shipped the parked follow-up:
  a teammate's `F, <name>` about a referral lead whose details are still
  withheld is parked on the live AiFlow run
  (`__follow_up_requested_by`) and applied when `upsert_customer` files
  the contact. Same PR also fixed the self-send guard that killed Amy's
  run when she claimed her own lead (run `bafe79fc`, business `621a5b0d`).
- **#1706** (OPEN since Aug 28, all 22 checks green, Bugbot SUCCESS,
  CLEAN/MERGEABLE as of Sep 5) removes the park mechanism, -1178 lines,
  keeps `followUpNoLeadText` and the self-send guard. It is held, not
  forgotten. The hold is a decision to let production answer first.
- **#1710** (merged Aug 28) is `debug/follow-up-park-watch.ts`, the
  read-only prober. It prints evidence (acks, cadence run, contact tags)
  and one verdict (self-send hits).

**The daily 9am check.** Brian ran it as a Claude Code routine (a saved
prompt scheduled in Anthropic's cloud via `/schedule`; those live in the
claude.ai account, not in `.claude/`, so there was no file to port). The
prompt, trigger (`0 16 * * *` UTC = 09:00 Phoenix, no DST), and the
decision table now live in `.cursor/skills/follow-up-park-watch/SKILL.md`
so the Cursor Automation and the Claude routine read one definition.
Neither Cursor nor Claude stores an automation in the repo: the skill
file is the tracked source, the dashboard entry is a paste of it.

**Decision table** (in the skill, summarized): 0 parked + 0 self-send =
still unproven, #1706 stays the candidate, report the day count. Parked
and every applied one shows "marked for follow-up" + tag + cadence run =
mechanism proven, #1706 not needed, recommend close. Applied marker with
no ack/tag/cadence = promise broken, #1706 or a fix IS needed. Any
self-send hit in the DEFAULT window = regression, independent of #1706.
"Did not mark" acks are a staff refusal, working as designed.

**Calibration is part of the run.** `--since 2026-08-28T00:00:00Z` must
surface `bafe79fc` in section 2. It did on Sep 5. The script labels that
hit REGRESSION because it cannot know the window was widened on purpose;
only a hit in the default window is a finding.

**Sep 5 2026 reading (this session):** 8 days since deploy, 0 parked,
0 self-send deaths. Row 1 of the table: still unproven.

**Sep 5 base-rate measurement (sms_inbound_jobs + ai_flow_runs, since
Jul 1):** 298 staff replies, 13 F-shaped, ALL Amy's tenant; 10 tagged
fine, 1 was "1, F" (user error), 2 were Rhonda inside the window. Three
more "F - name" texts went through the coworker AI path and also worked.
HomeLight is the only withheld-details source: 11 of 12 referral runs
opened `contact_release=withheld`, and only 5 of those 11 ever filed
`lead_phone`; the other 6 ended `done`/`failed` 1 to 2.5 hours later with
no phone and no contact row after. So a parked F fires in roughly 45% of
the windows it can be parked in. In the other 55% the run ends, the marker
dies with it (the only reader is `upsertCustomerStep`; there is no
end-of-run withdrawal, by design: "needs no sweep to expire"), and the
teammate who was told "I'll text you to confirm" is never texted. That is
a structural silent promise-break the #1706 defect table did not list.
Intersection so far: 1 lead in 9 weeks. At that rate a proven-good apply
is months away. The honest reply has a real cue behind it: the HomeLight
`to_agent` hand-off texts the claimer the moment the contact is filed, so
"re-send F" lands right when it can work.

Trap: zero here is not "works". The mechanism fires only when a teammate
texts F during a referral's withheld-details window, which is rare on
Amy's traffic. If it stays at zero for weeks, the honest reading is
"1178 lines nobody has exercised, with seven review-caught defects",
which is #1706's own argument. That call is Brian's, not the
automation's; the automation never edits, comments, closes, or merges.
