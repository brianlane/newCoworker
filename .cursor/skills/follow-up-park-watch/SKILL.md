---
name: follow-up-park-watch
description: >-
  Daily 9am check of whether the parked follow-up mechanism from PR #1702
  has fired in production, and therefore whether PR #1706 (which removes
  it) is still needed. Use when the daily follow-up-park-watch automation
  runs, when asked "has the F-park thing ever worked", or when deciding
  whether to merge or close #1706.
---

# Follow-up park watch

Three PRs, one open question:

- **#1702** (merged Aug 28 2026) shipped a mechanism: when a teammate texts
  `F, <name>` about a referral lead whose contact details the referral
  site is still withholding, the SMS webhook PARKS the request on the live
  AiFlow run (`__follow_up_requested_by` in the run's context vars) and the
  worker APPLIES it once `upsert_customer` files the contact (tags the
  contact `Needs Follow Up`, starts the cadence, texts the asker a
  confirmation).
- **#1706** (open, green, unmerged) removes that mechanism, net -1178
  lines, and keeps only the honest one-sentence reply
  (`followUpNoLeadText`: what was searched, why the lead can be missing,
  re-send `F` once they show on the dashboard). Its argument: the
  mechanism needed six rounds of review correction and every defect was a
  way to tell a teammate something untrue.
- **#1710** (merged Aug 28) shipped `debug/follow-up-park-watch.ts`, a
  read-only prober that says whether the mechanism has ever fired. At
  deploy: zero parked, zero applied across 500 recent runs. Passing review
  is not evidence that a thing works.

So the question #1706 hangs on is empirical, and it gets re-asked once a
day: has the mechanism fired yet, and if so, did it keep its promise?

The daily check began life as a Claude Code routine (a saved prompt on a
9am schedule in Anthropic's cloud, created with `/schedule`). It is
recorded here so the same job can run as a Cursor Automation, so both
tools read one definition, and so the decision rules are not re-derived
each morning.

## Run

```bash
npx tsx debug/follow-up-park-watch.ts
npx tsx debug/follow-up-park-watch.ts --since 2026-08-28T00:00:00Z
npx tsx debug/follow-up-park-watch.ts --business <uuid>
```

Needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`
(the Cloud Agent environment already carries them). Read-only: two
server-side filtered selects on `ai_flow_runs`, plus per-run lookups in
`sms_outbound_log` and `contacts` when something was applied. Exit 0 on a
clean read, 1 when a query failed, 2 when the env is missing.

The default window opens at the #1702 deploy instant
(`2026-08-28T18:20:29Z`). Widening `--since` to the start of Aug 28 must
surface Amy's Rhonda J. self-send death (run `bafe79fc`) on check 2; that
is how you know the detectors still work when the default window reads
zero. A zero you have not calibrated that way is not evidence.

## Read the output

The script prints evidence, not verdicts (its header explains why: four
earlier versions adjudicated and every one of eleven review findings was
the verdict being wrong). Two sections:

1. **Runs carrying a parked follow-up request.** For each: lead name, who
   asked, whether it was applied, the acks texted to the asker from that
   run, the cadence run the apply enqueued, and the filed contact's tags.
   The ack body is the strongest evidence, because the three outcomes are
   distinguishable in plain words: "marked for follow-up" (applied), "NOT
   calling them yet" (could not, will retry), "did not mark" (refused: the
   filed contact is one of our own numbers, production working as
   designed).
2. **Runs killed by the self-send guard.** A literal match on
   `last_error`. Any hit is a REGRESSION of the other half of #1702 (the
   teammate exemption that stopped Amy's run dying when she claimed her
   own lead). This is the one verdict the script keeps.

## Decision rules for #1706

| Section 1 | Section 2 | Reading | What to say |
| --- | --- | --- | --- |
| 0 parked | 0 | Still unproven, N days since deploy | #1706 stays open and stays the candidate. Report the day count; nothing else to do. |
| parked, every applied one shows a "marked for follow-up" ack, a tag, and a cadence run | 0 | Mechanism proven in production | #1706 is NOT needed. Recommend closing it. Do not close it yourself. |
| parked, NOT YET applied, contact still unfiled | 0 | In flight | Say so; re-read tomorrow. |
| an applied marker with no ack, or an ack with no tag or no cadence run, or "NOT calling them yet" that never resolves | any | Promise broken | #1706 (or a fix) IS needed. Report loudly with run ids. |
| any | > 0 | Self-send regression | Report loudly with run ids. Independent of #1706, since #1706 keeps the guard. |

"Did not mark" acks are a staff refusal, which is production working as
designed. Do not count one as a broken promise.

Also read `gh pr view 1706 --json mergeStateStatus,mergeable` each run.
#1706 touches `supabase/functions/ai-flow-worker/index.ts` and
`telnyx-sms-inbound/index.ts`, two of the busiest files in the repo, and
the day it reads `CONFLICTING` or `DIRTY` is the day waiting starts to
cost something. Say so when it happens.

The automation never modifies code, never comments on or closes #1706,
and never merges anything. Brian decides. Its job is to make the decision
cheap by putting the evidence in front of him every morning.

## Cursor Automation

Create it at cursor.com/automations (or with `/automate` from a local
agent session). Settings:

- **Trigger:** schedule, cron `0 16 * * *`. That is 16:00 UTC, which is
  09:00 America/Phoenix; Arizona observes no DST, so the wall-clock time
  never drifts. If the schedule UI takes a local time, enter 9:00 AM
  Phoenix.
- **Repository:** this repo (single repository), branch `main`. The
  script needs the checkout and the environment's `.env`.
- **Tools:** none beyond the base set. Memories ON, so the day count and
  yesterday's reading carry over. No PR tool, no Slack unless a channel
  is wanted; the run summary in the Agents window is the report.
- **Permissions:** Private is fine; it only reads.
- **Prompt:** the block below, verbatim.

```
Follow `.cursor/skills/follow-up-park-watch/SKILL.md`.

Run `npx tsx debug/follow-up-park-watch.ts` with no arguments. Then run
it once more with `--since 2026-08-28T00:00:00Z` and confirm section 2
finds run bafe79fc. That hit is the pre-deploy failure the guard was built
from, so the script's REGRESSION label on the widened run is expected and
is not a finding; only a hit in the DEFAULT window is. If the widened run
does not find bafe79fc, the detectors are broken, say so, and stop. Read
`gh pr view 1706 --json mergeStateStatus,mergeable,state`.

Report, in this order: days since the 2026-08-28T18:20:29Z deploy; the
count of parked runs and, for each, whether it applied and what the asker
was told; the self-send count; #1706's state and merge status; then ONE
line applying the skill's decision table, naming which row matched.

Do not edit code, do not comment on or close #1706, do not merge anything.
If a row other than "still unproven" matched, or #1706 reads CONFLICTING
or DIRTY, open your report with "ACTION" so it is not skimmed past.
Never use an em dash anywhere in the report.
```

## Claude Code routine

The same prompt runs unchanged as a Claude Code routine: `/schedule daily
at 9am` in a session on this repo, paste the block. Keep both pointed at
this file so a change to the decision table reaches both.
