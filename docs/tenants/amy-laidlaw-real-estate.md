# Amy Laidlaw Real Estate

Our oldest and heaviest tenant, and the one that drives most AiFlow engine
work. If a flow feature exists, Amy probably asked for it first.

## Identity

| | |
| --- | --- |
| Business id | `621a5b0d-c2ad-449f-9d74-9d50e7b27fa3` |
| Tier / box | standard, VPS `1863856` (biennial cutover 2026-07-28 from `1800980`, see Billing). Term box, Hostinger billing sub `6olQFVQi75HF2es2`, expires 2028-07-14 |
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
| Follow Up Requested (Unclaimed Leads) (tag_changed, 3) | Day-of router for unclaimed leads who asked for a follow-up: adding the "Follow Up Requested" tag (or Run now with context text) races Dave + Gabby (seller/both) or Dave + Gabby + Jason (buyer), 15-min claim window, Amy is the owner fallback and never in the race. Offer SMS carries *asterisk* emphasis by request |
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
- **A browse step that "fails" may have already succeeded.** On Aug 4 2026 the
  Clever Lead - Accept flow walked the portal's accept wizard to completion, the
  referral WAS accepted (the stored failure page reads "You just accepted your
  204th Clever Referral"), and the run was dead-lettered anyway: the finished
  wizard left its Next button visible but inert, and the render service's click
  loop was probing for VISIBLE while the click it guarded needs ACTIONABLE. 19
  steps never ran, so a $225K seller was accepted on Clever and never reached
  the QT email or Dave. The engine no longer fails a wizard that advanced and
  then went inert, and step 1 now carries `continueWhenText`, which records the
  step skipped and CARRIES ON (unlike `skipWhenText`, which ends the run and is
  the right answer only when another agent owns the lead). That marker also
  makes the accept step idempotent, so the flow is now safe to re-run for a lead
  it already accepted. Applied by `patch-clever-accept-idempotent.ts`.
- **The spoke-check flow was enabled and had NEVER run (fixed Aug 6 2026).**
  "Clever - Spoke Check & Weekly Call Follow-Up" triggers on `owner_assigned`
  with a `contains "clever"` condition, which reads the `tags: …` line of the
  contact-event text. But the route_to_team claim that assigns the owner only
  knew the lead's phone, so the event rendered as three lines (event / phone /
  owner) with no tags line at all, and the condition could never match:
  `ai_flow_runs` held zero rows for the flow while 34 contacts carried the
  exact `Clever` tag. Fixed at the shared chokepoint, not here, so every
  contact-event write site gets the documented shape:
  `enqueueContactEventRuns` now reads the contact's name/email/tags before
  evaluating conditions. The flow definition was correct all along and needed
  no patch. Two HQ flows ("Demo caller follow-up", "Webchat lead follow-up")
  had the same dependency. If you are counting on this flow as the safety net
  that keeps calling unclaimed leads, note it provided none before this date.
  Confirmed working on Aug 10 2026: 7 runs, each carrying the full
  name/phone/email/tags/owner text, reading real addresses off the lead pages
  and sleeping between weekly calls.
- **The spoke check could not reach a lead nobody ever claimed.** Its only
  trigger was `owner_assigned`, which is backwards for a safety net: leads that
  already got human attention also got the AI follow-up, and untouched leads
  got nothing. On Aug 10 2026 that was 14 of 45 Clever-tagged contacts with no
  owner, every one still tagged only "New Lead, Clever" (never advanced to
  Contacted or Engaged), the oldest untouched for 25 days. Closed by
  `patch-clever-spoke-check-unclaimed-leads.ts`, which adds a `tag_changed`
  trigger on the `Clever` tag so a lead enters at ACCEPTANCE and the existing
  3-day `grace` sleep becomes the timer.

  **Do not "fix" this with a `contact_created` trigger**, which is the
  intuitive choice and cannot work: the accept flow creates the contact at
  step 4 (`save_contact`) and only tags it "Clever" at step 5 (`tag_clever`),
  so a contact_created event fires one step BEFORE the tag exists and nothing
  keyed on "clever" can match it. Two details that make the tag_changed
  trigger need no other edit: a tag_changed event has no `owner:` line, so
  `spoke_owner` resolves to "none" and `spoke_check`'s `agentNameVar` pin
  leaves the step UN-pinned (it offers to the roster rotation, which is right
  for an unowned lead); and the `converted` goal already lists
  `{kind: "claimed"}`, so a lead claimed mid-grace jumps to the goal and is
  never called. The same patch sets `options.allowReentry=false`, which is
  load-bearing, not cosmetic: with two triggers a lead that is tagged and then
  claimed matches BOTH and would get two parallel weekly-call chains.
  The patch does NOT backfill: leads already sitting unowned emit no new
  tag_changed event and need a separate deliberate backfill.
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
- **Every team-facing notice carries `Address: {{vars.lead_address}}`, one
  wording, one placement.** Amy asked in Aug 2026 why only some flows texted
  her the property address. There was no single bug: each flow was authored per
  vendor at a different time with no shared lead-summary block, so the address
  existed only where somebody typed it. Closed by
  `set-amy-lead-address-in-notices.ts`. Three things to keep in mind before
  adding or editing a notice here:
  - **`route_to_team`'s offer / fallback / claim templates do NOT collapse
    empty vars** (the worker renders them with plain `renderTemplate`, no
    `collapseEmpty`), so an address that can be ABSENT must be branch-gated,
    never templated unconditionally, or the team gets a bare "Address:" line.
    That is why ReferralExchange's owner recap is now three `when`-gated
    `notify_owner` steps: a buyer is shopping, not selling, and their referral
    page has no Address row at all.
  - **HomeLight publishes only city/ZIP** ("85205, AZ"), before and after the
    claim. Its Address line is coarse by vendor limitation, not by defect. The
    read was moved to the PRE-claim `open` step because `route_to_team` parks
    before the portal card is ever read.
  - **`lead_address` is not just display text**: it feeds the duplicate-lead
    gate (`duplicateLeadRunExists` in `_shared/ai_flows/reentry.ts`), where two
    runs for the same person at DIFFERENT addresses are treated as different
    leads. Only `Realtor.com Lead` sets `options.dedupeLeadRuns`, so nothing
    moved when the other flows gained the field. New Lead Intake is the one to
    watch: Amy is the source there, so its field returns the literal
    `not given` when she omits an address. Do NOT turn on `dedupeLeadRuns` for
    that flow without changing the field first, or "not given" starts acting
    like a property that differs from a real one.
- **Never delete or rename a step id on a live flow.** A parked run stores the
  step id its cursor pointed at, and `resolveResumeIndex`
  (`_shared/ai_flows/branching.ts`) returns null when that id is gone, which
  STOPS the run rather than guessing. This is why the ReferralExchange notify
  split reuses the existing `notify` id for the seller variant and only ADDS
  `notify_both` / `notify_buyer` beside it. The three sit consecutively, so a
  run resuming at `notify` still walks all of them and exactly one gate fires.

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
`patch-clever-group-reply-second-intro.ts`,
`patch-clever-accept-idempotent.ts` (Aug 4 2026: `continueWhenText` on the
accept step, see Sharp edges),
`clever-spoke-check-unclaimed-patch.ts` +
`patch-clever-spoke-check-unclaimed-leads.ts` (Aug 10 2026: the spoke check's
second trigger, see Sharp edges).

Other networks: `seed-referralexchange-aiflow.ts`,
`realtor-retrigger-guard.ts`. HomeLight's are listed in
[homelight-flow.md](homelight-flow.md).

Speed-to-lead (Aug 8 2026): `amy-speed-to-lead-definition.ts` (pure
builders) driven by `amy-speed-to-lead-patch.ts` (same mechanics: dry-run
default, per-flow `--only`, `--revert` from the ledger's stored previous
definition). Normal seller leads stopped being pinned to Dave: the claim
offer now goes to Gabrielle Mota, Amy, and Dave SIMULTANEOUSLY
(`agentNames` broadcast, one shared deadline, "First to reply 1 gets it.")
on Clever Lead - Accept, ReferralExchange route_seller/route_both, and New
Lead Intake route_seller/route_both; HomeLight's existing Dave-and-Amy
broadcast gained Gabrielle. The reach ladder on Clever's ai_call steps
became [Dave, Gabby, Amy] with `rotateFirst: 2`: Dave and Gabby take turns
ringing first call by call (cursor:
`ai_flow_team_members.last_reach_first_at`), Amy stays the last resort,
and the post-call summary follows whoever rang first
(`notifyFirstReachTarget`). The Clever spoke check swapped its Dave pin
for `agentNameVar: "spoke_owner"` (extracted from the owner_assigned
notice), so the day-3 "did you speak with them?" question reaches whoever
actually claimed the lead; runs already parked in the 3-day grace at apply
time never extracted the var and cascade to owner fallback for up to ~3
days, by design. Still Dave by static ref, deliberately out of scope: the
spoke check's WEEKLY calls' `transfer.toRef`/`notifyRef` (no dynamic
transfer-ref mechanism exists yet). The offers must stay `agentNames`:
`broadcastAll` would silently exclude Amy (`team_broadcast_enabled`
false), and broadcast name matching is full-name ("Gabrielle Mota";
"Gabby" reaches nobody).

Seller auto-call (Aug 7 2026): `amy-seller-ai-call-definition.ts` (pure
builders) driven by `amy-seller-ai-call-patch.ts` (idempotent, dry-run by
default, `--revert` restores the exact previous definition from the ledger).
The AI now owns FIRST contact on both seller sources: it dials the seller
within a minute of the lead landing (skipping $1M+ leads, which stay with
Amy), pitches the listing with Amy's approved script (the Clever variant
carries the cash-offer angle and a new `cash_offers` extraction field copied
verbatim from the spoke check; ReferralExchange does not), then the flow
continues to the unchanged `route_to_team` chain so Dave still owns the
follow-up. Misses redial at +2h and next morning at 08:30, both inside
08:30-21:00 Phoenix with `outside: "skip"` so an overnight lead never parks
the run, and every rung stops the moment anyone claims the lead or the
seller replies or books (`lead_reached` goal). The same patch sweeps the
"best time to reach them" capture field out of New Lead Intake: Amy's rule
is that nobody ever asks a lead when to call back. Since Aug 7 2026 the
call steps carry `reachTeammate` (Dave, then Amy, 20s each) instead of the
single-target transfer: the AI keeps the seller talking while each phone
rings on a second leg and bridges only a genuine answer
(`upgradeCallsToReachLadder` swapped the already-live Clever flow in
place). Team offers now say what
the AI already did (`actions_taken`), how the call went
(`call_outcome_label`), and what the ladder does next, with the schedule
sentence generated from the same constants as the sleeps so copy and
behavior cannot drift apart.

Notice content: `set-amy-lead-address-in-notices.ts`,
`amy-lead-price-in-notices.ts` (Aug 7 2026: Clever never extracted a price at
all, only the over/under-$1M routing token, so no Clever notice could show
one; Realtor.com had the figure but only on some of its notices. Both were the
same shape as the address gap #1202 closed. Watch the collapseEmpty trap
documented in both scripts: route_to_team templates render with no
collapseEmpty, so any price var must extract with a "none" fallback or a
teammate gets a bare "Price:" label).

Show the team what the lead said (Aug 10 2026): the same
`amy-unclaimed-reminders-patch.ts` also sets `shareContactHistory` on all 13
route steps. A teammate used to see structured fields plus a status label
("The call: spoke with them") and never a word the lead actually said, so an
ask the AI agreed to on their behalf never reached the person who had to honor
it. Daniel Villanueva, Aug 7: he asked on the call for comparables by email and
a Monday conversation, and Dave's offer text carried none of it.

Now the lead's OWN words ride along: a short excerpt appended to every offer
(2 lines) and a fuller one texted to whoever claims it (4 lines). Three things
worth knowing:

- **The claimer used to be told nothing at all.** The owner got a claim notice,
  the losing offerees got a courtesy note, the claimer got silence. The history
  text is the first message the platform sends the person who took the lead.
- **It reads `voice_call_transcript_turns` where `role = 'caller'`, NOT
  `voice_call_transcripts.summary`.** The summary is written by a five-minute
  sweep and only for standard/enterprise tenants, so it is empty exactly when a
  just-finished call matters most; the turns are written live by the bridge.
  `_shared/ai_flows/contact_said.ts` is the first edge-side reader of that table.
- **Only the lead's side is shown, never our outbound.** That is the deliberate
  difference from `_shared/contact_context.ts`, which is model-facing and
  includes our own sends. Per-call the last three substantive caller turns are
  kept, dropping two-word pleasantries, because a lead states what they want at
  the END of a call ("Thank you." must never displace the ask).

Unclaimed-lead reminders + claim by name (Aug 10 2026):
`amy-unclaimed-reminders-patch.ts` (applier, `--revert` strips both back off)
over `amy-unclaimed-reminders-definition.ts` (pure builder, pinned by
`tests/amy-unclaimed-reminders.test.ts`). Turns on `unclaimedReminders`
(3 rounds, 20 minutes apart) for all 13 `route_to_team` steps across her seven
lead flows, so a lapsed offer nudges the SAME teammates three more times
before Amy inherits it, one interval after the last round. Two behaviors worth
knowing before touching this:

- **Reminders fire on silence only.** An explicit "2" from every teammate is a
  decision, so the everyone-passed path still hands the lead over
  immediately. Only a timeout (or an exhausted rotation) starts the ladder.
- **Reminders are compact by design and never re-send the offer body.** Her
  Clever offer is the full referral blob, roughly ten billed SMS segments;
  re-sending it three more times per recipient would quadruple the messaging
  cost of every unclaimed lead. Each step carries a short `detailsTemplate`
  instead, built from vars that flow actually produces (the schema rejects a
  template naming a var no earlier step writes, which is the guard that will
  catch you if you copy one flow's line into another).

The same PR changed the CLAIM REPLY fleet-wide, not just for Amy. A teammate
holding two or more live offers used to have a bare "1" resolve to whichever
run row was touched most recently, which is usually but NOT always the newest
offer (an escalation re-park or quiet-hours deferral moves an older run to the
front), with nothing texted back to say which lead they got. Now a bare "1"
with several pending asks which one, and `"1, <name>"` picks by partial name
match (accents folded, first name or surname both work) with a confirmation
text naming the lead. The suffix falls through to the ETA parser when it
matches no lead, so `"1, 20 min"` is unchanged. Before this, `"1, Daniel"` was
silently stored as an ETA and texted to Amy as `ETA to contact lead: Daniel`,
and its non-empty suffix also switched off the first-to-claim yank.

Follow-up requests (Aug 10 2026): `seed-amy-followup-request-aiflow.ts`
(applier) over `amy-followup-request-definition.ts` (pure builder, pinned by
`tests/amy-followup-request-definition.test.ts`). Seeds the
"Follow Up Requested (Unclaimed Leads)" flow after a Clever seller's Friday
"email me comparables, talk Monday" reached Monday with the lead unclaimed
and nothing scheduled: the spoke check's unclaimed track (above) starts at
acceptance with a 3-day grace and no backfill, so day-of commitments and
already-sitting leads had no home. Entry is the "Follow Up Requested" tag
(tag_changed, added) on the day the follow-up is due, or a manual Run now
whose input text carries name/phone/type/context. Seller and both-type leads
broadcast to Dave + Gabrielle, buyers add Jason, Amy stays out of the race
(her roster row has routing_enabled=false) and is the owner fallback. A claim
auto-assigns the owner, which chains into the spoke check's weekly track for
Clever-tagged leads: intended. The offer SMS uses *asterisk* emphasis on the
header, "today", and the reply digits, per Amy's ask.

Account-level: `seed-amy-new-lead-intake.ts`,
`backfill-amy-lead-stages.ts`,
`disable-amy-voice-booking.ts` (Aug 3 2026: voice stops booking, see Sharp
edges), `disable-amy-customer-booking.ts` (Aug 3 2026: finishes the same
policy on webchat + email; dashboard stays on by design),
`set-amy-claim-notify-email.ts`, `set-amy-roster-availability.ts`,
`set-amy-lead-address-in-notices.ts` (Aug 5 2026: the property address in every
team-facing notice on all six lead flows, see Sharp edges),
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

**The switch changed her box id**, which is the part that catches people out
later. A term change buys a NEW machine rather than re-terming the old one, so
`1800980` (monthly, provisioned Jul 5) became `1863856` (biennial, adopted Jul
28). Same cutover shape as KYP and Scar Fairy; Amy's was the first, which is
how her Identity row went a week pointing at the wrong box. Read
`businesses.hostinger_vps_id` rather than this file when it matters.

The old box was returned cleanly: `vps_inventory` has `1800980` as
`state=available` with no assigned business, and Hostinger has it `suspended`
with its subscription `cancelled`, `is_auto_renewed=false`, `next_billing_at`
null. Nothing is still being charged for it.

One wrinkle it leaves behind: its `vps_ssh_keys` row is still unrotated under
Amy's `business_id`, so tooling that iterates BOXES rather than tenants still
lists it under her name. `debug/update-all-vps.ts` (chat-worker) is the one
that does, deliberately, and it will now fail to SSH a suspended box and report
that per box. The per-tenant sidecar sweeps are unaffected: they resolve
through `getActiveVpsSshKeyForBusiness` / `newestKeyPerBusiness`, which pick
the newest row per business and so land on `1863856`.

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
