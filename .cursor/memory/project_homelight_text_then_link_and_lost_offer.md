---
name: homelight-text-then-link-and-lost-offer
description: HomeLight alert+URL 35ms race and ungated offer of a lost referral (Sonia R., 2026-09-13)
metadata:
  type: project
---

## homelight-text-then-link-eval-before-persist

**HomeLight sends the alert and the URL as two SMS, often 35ms apart, then a
"too late" text.** The trigger is `has_url` AND
`New HomeLight (Referral|Warm Transfer)`. If the webhook evaluates that AND
against jobs already in `sms_inbound_jobs` and only THEN inserts the current
row, the first two deliveries each see only themselves. Neither matches. The
withdrawal 16s later sees both prior jobs, matches, and starts the run.
`trigger.event_id` is then the withdrawal, not the alert.

Proven 2026-09-13, Sonia R. (Queen Creek AZ, $448,159), run
`76248380-af0f-4572-9368-04b93ddd1b1e`, jobs `5cbe9178` (alert), `9bbe5ef7`
(URL 35ms later), `9955df13` (withdrawal). `startImmediately` was already on;
the run started ~0.8s after create. The bug was correlation, not the queue.

**How to apply:**
- Persist `sms_inbound_jobs` BEFORE `evaluateAndEnqueueAiFlows` (pending on
  the main path, done on Safe Mode). Skip appending `current` onto the
  correlation window when the last same-from job already has that text.
- Skip enqueue when an ACTIVE run of the same flow already carries this
  `trigger.url`. Key the URL as the NEWEST link in the window
  (`lastUrlInText`), never the first: HomeLight sends many leads from one
  sender, and the oldest URL is a previous referral. Fail OPEN on lookup
  error. Empty URLs never dedupe. A unique partial index on
  `(flow_id, trigger.url)` for active statuses is the atomic close of the
  35ms sibling race; `dedupe_key` stays the per-SMS event id so a later
  run of the same URL after done is not blocked. The migration cancels
  extra QUEUED rows of the same URL only (35ms siblings, or queued behind
  an already-parked run). It does not cancel running / awaiting_* rows:
  db push runs before lastUrlInText is live, so two parked HomeLight
  leads can share the older URL. If two parked runs share a URL, the
  unique index fails loudly. 23505 on insert is the sibling of THIS
  referral; a later lead whose newest window URL is different is a
  different key.
- Insert `sms_inbound_jobs` with `suppress_reply` true. Flip it false
  only after eval, and only when no suppressing flow queued and the wait
  does not own the coworker. If the worker already claimed the row, the
  update no-ops: skip the coworker reply rather than send one on a
  flow-owned turn.
- Do NOT set `allowReentry=false`: HomeLight sends many leads from one sender
  while earlier runs are still parked.
- One-shot `homelight-claim-then-offer.ts` is the flow half. Applied Sep 14
  2026 after main Vercel Deploy of PR #1842 (`207d2c46`). Ledger row on
  Amy's HomeLight Referral (`4a3b03f4`). Merging a PR does not apply a
  one-shot.

## homelight-ungated-route-offered-a-lost-lead

**`route_to_team` with no when-guard will offer a referral HomeLight already
gave away.** Sonia's `open` read `claim_mode=none`,
`already_claimed=yes`, `claim_state=another agent has it`. Claim click/text
skipped. Verify confirmed taken. Route still ran. The offer said both
"Claim status: another agent has it" and "First to reply 1 gets it." Amy
replied 1. That was our roster claim. `wait_hl_call` was gated on
`claimed_agent notEquals none`, so we then waited for a HomeLight call that
was never going to come. Zero `voice_handoff_sessions`. The voice flow never
rang `+14159851909`.

**How to apply:**
- `when` is one condition on one var. Nest wait inside `claim_mode equals
  call` so `hl_call_outcome` is always written before
  `notEquals "no_call"`. A missing var is `""`, and `"" notEquals "no_call"`
  PASSES. Putting that when on a trunk route after a skipped wait would still
  offer lost leads.
- Lost / no-call copy is `notify_lead_owner` with `unownedFallback: "team"`.
  That is an alert. It must not say "Reply 1".
- Trunk cap is 30. Nest; do not add a net trunk step.
- Do not requeue Sonia's run. Do not `--click` Claim/Decline on a live
  `hmlt.co` probe: the link self-authenticates.

See [[project_homelight_portal_traps]], [[project_claim_by_reply_one]],
[[project_edge_functions_deploy_on_main]].
