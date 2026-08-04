# Amy Laidlaw Real Estate

Our oldest and heaviest tenant, and the one that drives most AiFlow engine
work. If a flow feature exists, Amy probably asked for it first.

## Identity

| | |
| --- | --- |
| Business id | `621a5b0d-c2ad-449f-9d74-9d50e7b27fa3` |
| Tier / box | standard, VPS `1800980` |
| DID | `+16028053377` |
| Owner | Amy Laidlaw |
| Onboarded | 2026-04-29 |
| Roster | Amy Laidlaw, Dave Lane, Jason Lane, Gabrielle Mota |

## How leads arrive

Amy buys leads from referral networks, and each network has its own delivery
mechanic. That is why this account has ~20 flows rather than two: the flows
are not variations on a theme, they are adapters to four different vendors.

- **Clever** sends group texts from a rotating pool of numbers, so a lead is a
  text thread the agent joins rather than a record it receives.
- **HomeLight** calls a live-transfer line and reads a referral out loud,
  expecting a keypress to accept. See [homelight-flow.md](homelight-flow.md).
- **ReferralExchange** and **Realtor.com** deliver leads that then need
  routing to whichever teammate is available.

**Lead state is written by the platform, not by these flows.** Stage tags
(New Lead, Contacted, Engaged, Booked) are applied automatically at the four
lifecycle moments in
`supabase/functions/_shared/pipelines/lifecycle.ts`, and `contacts.lead_source`
is stamped from the filing flow's name, so the Tasks board and its SOURCE
column populate themselves. Do NOT add `update_contact` stage steps to these
flows: the platform already covers it, and a hand-authored stage tag would
fight the forward-only rule. The leads that predate this were backfilled by
`backfill-amy-lead-stages.ts`.

## Flows

Roughly 21 flows, 19 enabled. The ones with behavior worth knowing before you
touch them:

| Flow | Why it is not obvious |
| --- | --- |
| HomeLight Referral (sms, 24 steps) | The biggest flow in the fleet. Own file. |
| HomeLight Live Transfer (voice) | The AI answers and works the call itself (`answerFirst`) |
| Clever Lead - Accept (sms, 13) | Accept path for Clever's group-text leads |
| Clever Lead - Group Reply Intro / Connected | Two-step flows reacting inside a group thread. Clever sends TWO intro wordings; the Intro flow matches both (the second via an extra OR trigger, Aug 2026). Connected is deliberately left unmatched (greet-only decision). An OLD disabled copy of the Intro flow still exists, do not edit that one |
| Clever - Spoke Check & Weekly Call Follow-Up (owner_assigned, 15) | Owner-assigned trigger, not lead-driven |
| Clever Cue Text | Arms an expected-call window so a transfer from a rotating Clever number is recognized (PR #781) |
| ReferralExchange Lead (sms, 31) | Browse-screenshot steps, gated owner emails, gated MMS routing, bad-phone retry tail |
| Realtor.com Lead + Reply forward | Reply forwarding to the lead owner |
| New Lead Intake (manual, 10) | Owner hands the AI a lead by name; the AI calls the lead, speaks their language, and can pin the lead to a named teammate |
| Voice routing - calls from ... | Five per-source voice-routing flows, keyed to each network's caller IDs |

Read the live state rather than this table when it matters:
`tsx debug/flow-poll.ts 621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`.

## Sharp edges

These are mistakes already made on this account. Do not remake them.

- **A teammate is never a lead.** Dave and Amy have both been filed as
  customers by flows that texted them. The rule and its guard are in the
  README ("A teammate is never a lead, however the step addressed them");
  `fix-staff-contact-rows.ts` cleaned up the rows that already existed.
- **Never hardcode a teammate name in a flow step.** Rosters change. Use
  `agentNameVar` for a dynamic teammate pin (PRs #876, #877).
- **The group-reply greeting once extracted our own agent's name**, producing
  "Hi Amy" to Amy (PR #856). Any greeting-extraction change needs a group-text
  case in its tests.
- **Clever rewords its intro templates without notice.** A second wording
  ("meet your top-rated local Clever agent") dropped the phrase "Clever Real
  Estate", matched no flow for weeks, and fell to the default assistant: the
  lead got no branded greeting and Amy was paged "needs you to take over"
  with the group-thread label (Jul 31 2026, fixed by
  `patch-clever-group-reply-second-intro.ts`). Anchor Clever triggers on the
  fixed group line plus short stable fragments of the wording, never the full
  brand name. The Connected flow still requires "Clever Real Estate" and so
  currently matches nothing; that is the deliberate greet-only decision, not
  an oversight.
- **A channel policy set with tool toggles reaches only the channel you set
  it on.** `patch-amy-sms-handoff-and-emoji.ts` decided this account nurtures
  and hands off rather than books, and enforced it by disabling the five
  calendar tools for `agent_key = 'sms'` (Jul 29 2026). Voice was never given
  the same rows, and a MISSING `agent_tool_settings` row means "registry
  default", which for the calendar tools is enabled. So the phone coworker went
  on booking for five more days, correctly following this account's own
  voice-side rule in `memory_md` ("Use the team calendar to schedule
  consultations/showings by default") while `soul_md` told SMS the opposite.
  Chris Bartelot's Aug 3 call surfaced it: a listing consultation offered
  fifteen minutes out, pushed four times, then booked. Closed by
  `disable-amy-voice-booking.ts`. When you set a channel policy here, check
  every channel: `tsx debug/audit-agent-tool-channels.ts` lists every tool that
  is off on one surface and still on for another, fleet-wide.

  That audit's first run showed the policy was still only three quarters
  applied: `webchat` and `email` were left default-on, so both could still
  book. Closed by `disable-amy-customer-booking.ts`, which drives off the tool
  registry rather than a hardcoded list, because the channels do not carry the
  same tools (webchat has 2 of the 5, voice 3, sms and email 5). The audit is
  silent for this tenant now.

  `dashboard` is deliberately still ON, and should stay: that surface is Amy
  asking her own assistant, not the AI acting at a customer unsupervised. She
  enabled booking there herself on Jun 14 2026. The audit compares
  customer-facing surfaces only for exactly this reason, so dashboard does not
  keep her on every run; `--include-dashboard` shows it when you want it.
- **Editing a live flow by hand in the UI is how flows get broken here.** It
  has needed a revert at least once. Prefer a ledger-recorded one-shot in
  `scripts/oneshot/`, which is idempotent, dry-run by default, and reviewable.
- **Amy's flows are the fleet's stress case for step counts.** The
  definition-wide step cap went 50 -> 150 for this account (PR #634).
- **Never name a gate field so it reads like a phone field.** `phone_lead_type`
  held buyer/seller/both, but `isPhoneFieldName` matches any phone token in a
  name, so when the engine began validating phone fields (PR #885, Jul 24 2026)
  every value became "none". All three ReferralExchange `route_to_team` steps
  skipped for eight days: 11 leads were texted but never offered to the team,
  and Amy's owner alert claimed "no phone" while naming the number just texted.
  The engine no longer rewrites a value that is not a phone attempt, and the
  fields were renamed (`route_lead_type`, `sms_lead_type`). Audit the fleet for
  the same shape with `tsx debug/audit-phone-field-names.ts`.

## One-shots

Which of these actually ran, and when, is in the ledger, not here:
`select script, applied_at from applied_oneshots where business_id =
'621a5b0d-c2ad-449f-9d74-9d50e7b27fa3' order by applied_at desc`.

Clever: `seed-clever-lead-accept-aiflow.ts`,
`seed-clever-lead-group-reply-aiflow.ts`, `seed-clever-cue-aiflow.ts`,
`seed-clever-spoke-check-aiflow.ts`, `seed-clever-homeward-aiflow.ts`,
`seed-clever-update-leads-aiflow.ts`,
`seed-clever-update-leads-chris-aiflow.ts`,
`seed-clever-voice-transfer-rule.ts`, `clever-spoke-check-definition.ts`,
`patch-clever-accept-followup.ts`, `patch-clever-cue-arm-transfer.ts`,
`patch-clever-group-reply-name-desc.ts`, `fix-clever-existing-flows.ts`,
`clever-start-immediately.ts`,
`patch-clever-group-reply-second-intro.ts`.

Other networks: `seed-referralexchange-aiflow.ts`,
`realtor-retrigger-guard.ts`. HomeLight's are listed in
[homelight-flow.md](homelight-flow.md).

Account-level: `seed-amy-new-lead-intake.ts`,
`backfill-amy-lead-stages.ts`,
`disable-amy-voice-booking.ts` (Aug 3 2026: voice stops booking, see Sharp
edges), `disable-amy-customer-booking.ts` (Aug 3 2026: finishes the same
policy on webchat + email; dashboard stays on by design),
`set-amy-claim-notify-email.ts`, `set-amy-roster-availability.ts`,
`patch-amy-sms-handoff-and-emoji.ts`,
`patch-amy-handoff-single-alert.ts` (step 3 rewrite: notify_team OR reasoning
handoff, never both for one request; the Jul 28 block's "and/or" double-paged
the claimed agent on four leads Jul 30-31),
`update-dave-routed-aiflows.ts`, `add-price-band-routing.ts`,
`add-bad-phone-agent-report.ts`, `enrich-owner-notify.ts`,
`fix-staff-contact-rows.ts`, `strip-em-dashes-flows.ts`,
`recover-amy-biennial-switch.ts`,
`rename-phone-named-gate-fields.ts` (also touches KYP; renames the gate fields
that the phone-field validator was clobbering, see Sharp edges).

## Billing

Switched monthly -> Standard biennial on Jul 28 2026. The switch's Hostinger
purchase "failed but charged" (HTTP 402 while the order completed server-side
about a minute later), the orchestrator aborted, and the recovery was applied
by `scripts/oneshot/recover-amy-biennial-switch.ts`: the paid 2-year box was
adopted directly and the plan bookkeeping completed manually.

One durable caveat: the Stripe subscription OBJECT backing the biennial
contract is canceled (the abort path canceled it; the $2,376 payment itself
was captured and kept). That means the dashboard's contract auto-renew toggle
and `ensureCommitmentSchedule` are inert for this term. At the 24-month mark
(renewal Jul 28 2028) the plan card's "Start a new contract" CTA is the path
back onto a contract rate; it creates a fresh Stripe subscription.

`tests/tenant-dossiers.test.ts` fails if a tenant-named script exists without
a mention here, so adding a one-shot means adding a line.

## History

Notable PRs: #936, #927, #913, #911 (HomeLight), #877 / #876 / #854 (dynamic
teammate pin and New Lead Intake), #856 (group-reply greeting), #790
(broadcast route_to_team), #697 (bad-phone report), #613 (act on the answer,
not just acknowledge it).
