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

- **One HomeLight alert can arrive twice, and each delivery spawns a run.**
  Aug 11 2026: two runs six seconds apart (15:43:54, 15:44:00 UTC) both
  processed referral `hmlt.co/42a2915a` for seller "Marla". Byte-identical
  `windowText`, same sender, different inbound event ids. Both routed to the
  team, both texted Gabrielle Mota, and both parked in a 60-minute
  `wait_for_reply`. Neither existing guard could catch it: the 15-minute
  correlation window gathers text into one window rather than suppressing a
  second run, and sender-keyed re-entry cannot help because HomeLight sends
  every referral from the same number.

  **`options.dedupeLeadRuns` alone is INERT on this flow**, which is the part
  that catches people out. That gate bails when the run has neither phone nor
  email (`keys.length === 0` returns false), and HomeLight's first comm step
  (`route`) runs BEFORE `card` reads the contact details off the portal, so at
  gate time the run knows only a first name, a city, a price, and the referral
  link. Closed by `homelight-dedupe-and-price-digits.ts`, which pairs
  `dedupeLeadRuns` with `options.dedupeLeadRunsByVar: "leadUrl"`: the referral
  link is unique per lead and is extracted at step 0, so it is the only
  identity available in time. A var-key match is deliberately DECISIVE and
  skips the address comparison, because HomeLight publishes only city and ZIP
  before a claim.
- **`price_digits` is a matching token, not display text.** The same alert
  produced `507` in one run and `507258` in the other. It is one of the two
  `EMAIL_MATCH_TEMPLATES` (see `update-dave-routed-aiflows.ts`) used to match
  HomeLight's portal email back to the lead, so a wrong value means the
  late-arriving contact details never reach the flow. The old wording asked for
  "the leading digits ONLY" with $429K and $264,000 as examples, neither of
  which says what to do with $507,258. Reworded by the same one-shot. Note the
  300-character cap on a field description: the first attempt at the new
  wording was rejected by the validator before anything was written.

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
`realtor-retrigger-guard.ts`,
`homelight-dedupe-and-price-digits.ts` (Aug 11 2026: the duplicate-run and
`price_digits` fixes, see Sharp edges). HomeLight's others are listed in
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

**Only the Clever half of this is live.** The builder carries a
ReferralExchange variant and the intent was both seller sources, but the ledger
shows the patch applied twice, 2026-08-07 at 20:17 and again at 22:48, both
times against `Clever Lead - Accept` alone. The live `ReferralExchange Lead`
definition still has zero `place_ai_call` steps (verified Aug 11 2026), so a
ReferralExchange seller gets the intro SMS/email and the team offer and no AI
first contact at all. Closing it is a `--only "ReferralExchange Lead"` run, not
new code. Read the rest of this paragraph as the DESIGN, not as production.

On Clever, where it did land, the AI owns FIRST contact: it dials the seller
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

Voicemails (Aug 11 2026): `amy-voicemail-scripts.ts` gives all 13
`place_ai_call` rungs a `voicemailTemplate`, so a lead who never picks up now
hears from us instead of only being texted. Before PR #1297 the engine hung up
on an answering machine and there was no field to put a message in.

- **HomeLight is absent from that script by design, not by oversight.** It
  places no outbound AI call at all: its AI ANSWERS HomeLight's inbound
  live-transfer call, which by definition has a person on the line.
  ReferralExchange gets its scripts when it gets its call steps.
- **Every rung is worded differently**, because a ladder that redials leaves a
  message each time and three identical recordings from one number reads as a
  malfunction. The Clever accept ladder's third rung and the spoke check's
  eighth say plainly that they are the last, and week 7 warns that one more is
  coming.
- **The copy obeys the account's existing rules and its tests pin all of
  them:** no callback-time question (Amy calls back fast rather than booking an
  appointment to call), no em dashes, no "receptionist", and no price. That last
  one is the same decision `amy-price-every-lead-notice.ts` records: the figure
  is the referral network's estimate, and quoting it back at a seller in an
  unsupervised voicemail is a valuation claim.

Who hears an unowned lead's reply (Aug 12 2026):
`amy-roster-lead-type-tags.ts` writes what each teammate handles onto the
ROSTER (`ai_flow_team_members.tags`), and the cadence's reply notice uses
`notify_lead_owner`'s new `unownedFallback: "team"` with
`teamTagTemplate: "{{vars.lead_type}}"`.

- **The rule was true in exactly one place before this.** "Dave and Gabby for
  sellers, plus Jason for buyers" lived in the two arms of
  "Follow Up Requested (Unclaimed Leads)"; the other twelve route steps knew
  nothing about it and Jason appeared nowhere else on the account. On the
  roster it is one edit when someone joins or changes.
- **Amy is deliberately untagged**, and that is not an oversight. Her row
  already carries `team_broadcast_enabled=false`, which is what keeps her out
  of team alerts; a tag would not change that and would imply she belongs to an
  audience she does not. She stays on the CLAIM OFFERS exactly as the Aug 8
  speed-to-lead patch set them, which none of this touches.
- **A tag matching nobody alerts EVERYONE.** Tags are free text with nothing
  validating them, so the filter fails safe: a typo costs noise, never a lead.
  Same reason an empty render means "no filter" rather than "a tag nobody has".
- **This is an alert, not an offer.** Nobody is asked to reply, no deadline
  runs, and the flow does not park. `route_to_team` with `broadcastAll` is the
  offer-shaped alternative and remains a different thing.

Needs Follow Up cadence (Aug 11 2026): `seed-amy-needs-follow-up-aiflow.ts`
(applier) over `amy-needs-follow-up-definition.ts` (pure builder, pinned by
`tests/amy-needs-follow-up-definition.test.ts`). A lead tagged
"Needs Follow Up" gets an AI call every three days; when nobody picks up the AI
leaves a voicemail and then texts. Eight rounds, each worded differently, the
last saying it is the last. The tag comes from a teammate texting `F` (see
`follow_up_reply.ts`) or from any other tagger.

Four things worth knowing before touching it:

- **The wait IS the gap between rounds, and that is load-bearing.** The obvious
  build is a `sleep` plus a `goal` on `replied`, and it does not work: a goal's
  reached-marker is `__goal_<id>`, and a `when` guard's var must start with a
  letter, so nothing downstream can branch on whether the goal fired. Since a
  goal step is a JUMP TARGET, the steps after it also run when the ladder
  merely finishes, so an ungated notice would page the team about every cold
  lead: the exact opposite of the ask. `wait_for_reply` saves an ordinary var
  ("no_reply" on timeout, the lead's words otherwise), which is gateable.
- **Rounds 2 to 8 are FLAT branches**, each gated on `lead_reply` still being
  "no_reply", the same shape the Clever spoke check uses. Branch nesting is
  capped at 3 levels, so eight nested rounds was never an option.
- **`appointment_booked` and `claimed` stay a goal**, because nothing in the
  flow observes them: either jumps the run out of a parked wait so the AI stops
  calling someone a teammate has already taken.
- **Calling hours use `outside: "defer"`, and "skip" would break the whole
  feature.** Every round waits exactly 72 hours, so all eight land at the same
  clock time as the first. With "skip" a lead tagged at 2am resolves round 1 to
  `not_placed`, which is not `no_answer`, so the text does not send either, and
  three days later it is 2am again: one unlucky tagging time and the lead is
  never contacted at all. "defer" parks the first round until 08:30 and every
  later round inherits that daytime phase.
- **A later round stops ONLY when the lead was actually reached**: empty arms
  for `transferred`/`answered` with the work in `else`, the same shape the
  Clever spoke check uses. Both inverses are wrong. Gating only on the reply
  var lets a lead who SPOKE to the AI (possibly to say stop calling) keep being
  dialed; gating on `call_outcome equals no_answer` instead ALSO ends the
  cadence on a transient `failed` or a `not_placed` from the fleet-wide dial
  cap, abandoning a lead nobody ever reached because one dial did not go out.
- **The reply notice sits INSIDE each round, right after that round's wait.**
  One notice at the end gated on `lead_reply notEquals "no_reply"` looks
  equivalent and is not: a missing var reads as "", which is also not equal to
  "no_reply", so the guard PASSES. A `claimed` jump during the very first call
  would have sent the owner a "they came back to us" notice quoting nothing,
  for a lead who never said a word.
- **The unclaimed half of Amy's notify rule is not yet faithful.**
  `notify_lead_owner` resolves the owner at RUN TIME (so a lead claimed
  mid-cadence reaches the right person, which a var read at step 0 could not
  do), but with no owner it falls back to the business owner rather than
  broadcasting to the team. There is no informational team-broadcast
  primitive: `route_to_team` broadcasts as a claim OFFER with a deadline and a
  fallback, which is a different thing from an alert.

ReferralExchange on the AI worker (Aug 11 2026):
`referralexchange-ai-first-contact.ts` (applier, `--revert` restores the exact
previous definition) over `referralexchange-ai-first-contact-definition.ts`
(pure builder, pinned by `tests/referralexchange-ai-first-contact.test.ts`).
The AI now calls a ReferralExchange lead BEFORE the team is offered it, the way
Clever and HomeLight already work. 23 steps to 25.

- **All three lead types, each with its own script.** ReferralExchange delivers
  buyer, seller and both, unlike the seller-only sources, and the existing
  `amy-seller-ai-call-definition.ts` ReferralExchange variant is seller-gated,
  so it could never have covered this.
- **This is the ONE place the callback-time question is allowed.** The standing
  rule is that we never ask a lead when to call back, and Aug 7's
  `removeBestTimeCaptureField` swept it out of New Lead Intake. Amy narrowed
  the rule on Aug 11: it is fine in the single moment where the lead ASKED to
  be connected and nobody picked up. `captureFields` cannot be conditional, so
  the SCRIPT carries the condition, and the tests assert both halves of it.
- **A no-answer hands the lead to the cadence by TAG**, not by repeating a
  ladder here. `update_contact` adds "Needs Follow Up", the same chokepoint the
  `F` reply and the tag editor use, so there is one follow-up sequence and one
  place to change it.
- **The script arms gate on `route_lead_type`, not `lead_type`.** Both exist on
  this flow and only one says anything about REACHABILITY: `route_lead_type` is
  "the page shows a text or call option, meaning the lead has a real phone
  number, and here is the type", answering "none" for an email-only lead.
  Gating a DIAL on `lead_type` validates fine and then tries to call leads with
  no phone. It is also the field the three route steps already gate on.
- **First contact carries NO `callWindow`**, matching Clever's attempt-1 dial.
  A window with `outside: "skip"` resolves an overnight lead to `not_placed`,
  which is not `no_answer`, so the follow-up tag never fires either and the
  lead misses both the AI call and the cadence. Only RETRY rungs get windows,
  because a redial is the thing that must not land at 3am.
- **`captureFields` are not flow vars.** `place_ai_call` produces its outcome
  var and the two companions and nothing else; what the AI collected rides the
  POST-CALL SUMMARY to whoever the ladder rang first
  (`notifyFirstReachTarget`). Templating `{{vars.timeline}}` into an offer
  would be rejected by the authoring validator, and would render empty if it
  were not. The offers therefore quote `call_outcome_label` and point at the
  summary.

Who owns the lead, in Amy's own emails (Aug 12 2026):
`amy-owner-in-lead-emails.ts`. Five emails to amy@amylaidlaw.com never said who
took the lead, and all five sat BEFORE their flow's `route_to_team`, so no
template could have shown it from where they stood: Clever `qt_email`,
Realtor.com `s2`, and ReferralExchange `email_buyer` / `email_seller` /
`email_both`. They now sit after the route and carry
`Lead owner: {{vars.claimed_agent}}`.

- **HomeLight was the model, not an exception.** Its `qt_email` already sat
  after the route and already opened "HomeLight referral claimed by ...". The
  other four had simply never caught up.
- **The cost is real and worth knowing:** these emails now wait for the claim
  window instead of sending on arrival. A lead claimed quickly (the common case
  on this account, and the point of speed-to-lead) delays the email a minute or
  two. A lead NOBODY claims delays it by the full ladder, roughly ninety
  minutes: a 10 minute offer, three 20 minute reminder rounds, then the owner
  fallback.
- **Deliberately NOT copied from HomeLight:** its `qt_email` is gated on
  `claimed_agent notEquals none`, so an unclaimed HomeLight lead sends Amy no
  QT email at all. These stay ungated, because a lead nobody claimed is the one
  she most needs to see. The owner line reads "none" rather than the mail
  silently not arriving.
- **`claimedNotifyEmail` was already set** to amy@amylaidlaw.com on all four
  route steps, so she was already getting a SEPARATE claim email. This puts the
  fact in the lead email itself rather than leaving her to cross-reference two.
- The last route step is the anchor, not the first: ReferralExchange has three
  gated by lead type and only one fires, so after all of them is the only
  position from which the claim is known whichever arm ran.

Notice content: `set-amy-lead-address-in-notices.ts`,
`amy-lead-price-in-notices.ts` (Aug 7 2026: Clever never extracted a price at
all, only the over/under-$1M routing token, so no Clever notice could show
one; Realtor.com had the figure but only on some of its notices. Both were the
same shape as the address gap #1202 closed. Watch the collapseEmpty trap
documented in both scripts: route_to_team templates render with no
collapseEmpty, so any price var must extract with a "none" fallback or a
teammate gets a bare "Price:" label).

`amy-price-every-lead-notice.ts` (Aug 11 2026) finishes that job across the
whole account: 47 templates on all seven lead flows, so every team-facing text
about a lead carries the figure. The Aug 7 script had patched the two flows Amy
happened to have a notice from, which left the same partial coverage everywhere
else: 15 `claimedNotifyTemplate` / `ownerFallbackTemplate` where the offer named
the price and the "you got it" / "nobody took it" follow-ups did not, all 13
`unclaimedReminders.detailsTemplate`, and the AI-call gap/failure alerts, the
late-contact notices and every `bp_forward` relay. Four things worth knowing
before touching it:

- **Its per-flow target lists are exhaustive on purpose**, naming templates that
  already carry the price as well as the ones that did not. Nothing is patched
  twice (see the next point), so the lists double as a standing assertion of
  coverage, and a step id that disappears aborts the run rather than repeating
  the three-quarters-applied outcome the tool-toggle policy had.
- **Presence is tested on the price VAR, not on a "Price:" line.** Most of these
  notices state the figure in prose ("(~{{vars.price}})", "in Mesa, around
  {{vars.price}}"), so the Aug 7 script's exact-line test would have added a
  second labelled copy underneath the sentence. The dry run is what caught it.
- **Two flows had no price to template, so the script adds the extraction
  first.** Clever Spoke Check browses the SAME Clever lead page the accept flow
  does, so its `read_page` gets the identical field, worded verbatim from
  `CLEVER_PRICE_FIELD`. Follow Up Requested reads a contact-event or Amy's
  Run-now text and usually has no figure, so its field answers "none" more often
  than not; a real figure there would mean recalling and browsing the lead page
  on a same-day urgent path, deliberately not done.
- **Lead-facing copy is deliberately untouched.** None of the 15 SMS bodies
  addressed to a lead carries a price, and that is a decision, not a gap: the
  figure is the referral network's estimated home value, and quoting it back at
  a seller is a valuation claim sitting directly beside Amy's own "I have an
  appraiser to price your listing with precision" pitch.

The same PR fixed the guard that should have caught the reminder gap:
`unclaimedReminders.detailsTemplate` was missing from `templateStringsForStep`
in `src/lib/ai-flows/schema.ts`, so alone among outbound templates it was never
scope-checked, and a var no step produced would have rendered as a bare label on
every nudge with nothing flagging it at author time. It also fixed `--revert` on
`amy-seller-ai-call-patch.ts` and `amy-speed-to-lead-patch.ts`, which filtered
the ledger on a `script_path` column that does not exist (it is `script`, the
basename), so both rollbacks exited 1 on a PostgREST error instead of restoring
anything.

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
