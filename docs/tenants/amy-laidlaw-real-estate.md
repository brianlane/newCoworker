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

## Flows

Roughly 21 flows, 19 enabled. The ones with behavior worth knowing before you
touch them:

| Flow | Why it is not obvious |
| --- | --- |
| HomeLight Referral (sms, 24 steps) | The biggest flow in the fleet. Own file. |
| HomeLight Live Transfer (voice) | The AI answers and works the call itself (`answerFirst`) |
| Clever Lead - Accept (sms, 13) | Accept path for Clever's group-text leads |
| Clever Lead - Group Reply Intro / Connected | Two-step flows reacting inside a group thread. An OLD disabled copy of the Intro flow still exists, do not edit that one |
| Clever - Spoke Check & Weekly Call Follow-Up (owner_assigned, 15) | Owner-assigned trigger, not lead-driven |
| Clever Cue Text | Arms an expected-call window so a transfer from a rotating Clever number is recognized (PR #781) |
| ReferralExchange Lead (sms, 21) | Browse-screenshot steps, gated owner emails, gated MMS routing |
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
- **Editing a live flow by hand in the UI is how flows get broken here.** It
  has needed a revert at least once. Prefer a ledger-recorded one-shot in
  `scripts/oneshot/`, which is idempotent, dry-run by default, and reviewable.
- **Amy's flows are the fleet's stress case for step counts.** The
  definition-wide step cap went 50 -> 150 for this account (PR #634).

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
`clever-start-immediately.ts`.

Other networks: `seed-referralexchange-aiflow.ts`,
`realtor-retrigger-guard.ts`. HomeLight's are listed in
[homelight-flow.md](homelight-flow.md).

Account-level: `seed-amy-new-lead-intake.ts`,
`set-amy-claim-notify-email.ts`, `set-amy-roster-availability.ts`,
`patch-amy-sms-handoff-and-emoji.ts`,
`update-dave-routed-aiflows.ts`, `add-price-band-routing.ts`,
`add-bad-phone-agent-report.ts`, `enrich-owner-notify.ts`,
`fix-staff-contact-rows.ts`, `strip-em-dashes-flows.ts`,
`recover-amy-biennial-switch.ts`.

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
