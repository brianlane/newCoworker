---
name: claim-by-reply-one
description: how a bare '1' reply claims parked offers, unowned-lead alerts, and booking invites; LIFO by row touch; late claims ignore the name
metadata:
  type: project
---

## project_bare_digit_claim_is_lifo

How an AiFlow team offer reply resolves, established 2026-08-10 while building
Amy's claim-by-name work (PR #1270):

- **A bare "1" picks the sender's most recently UPDATED run row**
  (`findLiveOfferRunFor` in `supabase/functions/telnyx-sms-inbound/index.ts`,
  `order("updated_at", {ascending:false}).limit(1)`, mirrored at four
  selection sites). That is usually the newest offer but NOT always: an
  escalation re-park, a quiet-hours deferral, or any worker mutation stamps
  `updated_at` and moves an older lead to the front. Do not describe this to
  anyone as "reverse order received".
- `LIMIT 1` means extra pending offers are invisible, not merely deprioritized.
- **The text after "1," is the ETA slot** (`parseClaimWithTimeframe`), and it
  is opaque free text. Before PR #1270, "1, Daniel" was stored as a timeframe,
  texted to the owner as `ETA to contact lead: Daniel`, set
  `claimed_agent_eta_minutes` to 0, and its non-empty value silently DISABLED
  the first-to-claim yank (`late_claim.ts`, `timeframe === ""` guard).
- Since PR #1270: a bare "1" with 2+ pending asks which lead; "1, <name>"
  matches partially against the sender's own live offers (accents folded,
  exact beats partial) and only falls through to the ETA parser when nothing
  matches. `passed_by` on the routing state records who explicitly declined,
  separately from `tried` (which also collects timeouts and skips).

**Why:** two of the three Bugbot findings on that PR came from assuming the
step's CONFIGURED mode describes the run's CURRENT state. It does not: a run
parked with `routing.offered_all` must resume through the broadcast state
machine even when the step is pinned or rotating, because that is the only
handler that reads `offered_all`.

**How to apply:** when touching offer replies, reason from the RUN's parked
shape (`routing`), never from the step definition alone. Related:
[[project_ownership_never_binds_to_sender]],
[[feedback_check_for_a_shared_mechanism_first]].

## project_claim_by_reply_one_two_paths

Shipped 2026-08-16, PRs #1399 and #1404, both merged and live.

Brian's rule after a teammate replied "1" to an informational alert and it
landed on an unrelated old offer: **allow for both.** A teammate can claim by
text OR in the dashboard.

**Two mechanisms, because the alerts come from two places:**

1. **AiFlow no-phone guards** became real `route_to_team` offers
   (`amy-unreachable-lead-claim-offer.ts`). They sit inside a run, so the whole
   claim machinery applies for free.
2. **Dispatcher `notify_team` alerts** have NO run to park, so they attach to a
   new table, `unowned_lead_alerts` (one row per alert, not per recipient;
   claim is a compare-and-swap on `claimed_at is null`).

**`route_to_team` gained `teamTagTemplate`**, broadcastAll-only, resolved
through the same `selectBroadcastTeam` as `notify_lead_owner`. Without it the
offer conversion would have lost seller/buyer targeting, since `broadcastAll`
had no tag filter at all.

**Resolution rule:** a bare "1" counts live offers AND live alerts together;
one candidate acts, two or more asks which. A named claim ("1, Richard")
matches across the same combined list, with alerts carrying an `alert:<uuid>`
id prefix so `matchOfferByLeadName` stays the single implementation.

**Third class added 2026-08-20 (PR #1543): broadcast BOOKING claims.**
"Who bookings go to" gained a `broadcast` mode (the DEFAULT for businesses
created after the migration; existing tenants keep their stored mode), on
BOTH doors (public page + AI-made bookings via
`src/lib/booking-page/ai-door-assignment.ts`). Each broadcast booking parks
one `booking_claim_offers` row (`supabase/functions/_shared/booking_claims.ts`,
mirror of unowned_lead_alerts); the claim is a TWO-write CAS: the offer row
settles the race, then `calendar_booking_dedupe.assignee_member_id` is
stamped only while null. Booking candidates join the bare-"1" count, the
ambiguity ask-back, and the named matcher under a `booking:<uuid>` prefix.
Nobody claiming = booking stays unassigned past 24h, NO fallback ladder (the
owner alert fired at booking time). Winner ack + stand-down texts for other
invitees. A solo owner-only roster collapses broadcast to a direct owner
stamp with no invite (the #1500/#1542 rule).

**Four Bugbot findings on these two PRs, every one real and every one mine:**

- Tagging an offer on `route_lead_type` (see
  [[project_reachability_gated_vars_are_not_lead_type]]).
- An alert becoming an OFFER double-offers a lead where the trunk route is not
  phone-gated. Clever `route` and Realtor `s4`/`s4_buyer` gate only on
  `price_gate`, so those two carry the exact complement.
- Extending the ask-back without extending the ANSWER: naming an alert fell
  through to the ETA parser.
- Inviting "Reply 1" on an owner-addressed alert, which records no row.

**How to apply:** when you add a team-facing text, decide where a stray "1"
lands BEFORE shipping. And when a read decides whether to tell someone "you've
got it", capture the `error`: `maybeSingle` reports a multi-row match as an
error, and treating null data as "nobody owns it" is a false success. Related:
[[project_informational_team_alert_gets_replied_1]],
[[project_bare_digit_claim_is_lifo]], [[project_unowned_lead_alerts_tagged_team]].

## project_informational_team_alert_gets_replied_1

Observed live on Amy Laidlaw's account, 2026-08-15. An unowned-lead ALERT was
texted to Dave and Gabby. It was deliberately not a claim offer: no deadline,
no "Reply 1 to claim", and it closed with "Please reach out directly, then
claim them in the dashboard."

Gabrielle Mota replied **"1"** 57 seconds later anyway. The inbound handler
resolved it the only way it can, against her most recently updated live offer
row (see [[project_bare_digit_claim_is_lifo]]), and answered "You've already
got this lead, it's yours." The lead the alert was about stayed unowned.

**Why:** every other team text on this account ends in "Reply 1 to claim", so
"1" is trained muscle memory, not a reading of the message. An alert that is
structurally not an offer still LOOKS like one to the person holding the
phone.

**How to apply:** when adding any team-facing alert that is not an offer,
assume a bare "1" will come back and decide where it should land before
shipping. The alert/offer distinction is real in the engine
(`notify_lead_owner` + `unownedFallback: "team"` alerts, `route_to_team`
offers) and invisible on a phone. Either give the alert a real claim
affordance, or expect the ownership stamp to need a separate manual step.
Related: [[project_unowned_lead_alerts_tagged_team]],
[[project_ownership_never_binds_to_sender]].

## project_late_claim_path_has_no_name_matching

Found and fixed 2026-08-17 (PR #1432, merged) after Dave Lane's
"1, Aurora Anthony" claimed Jennifer Kline instead, on Amy Laidlaw
(`621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`).

**The bug.** Claim-by-name (PRs #1270, #1399, #1404) lived at ONE call site,
guarded by a non-empty live-offer list. `findLiveOfferRunsFor` filters
`status in ('awaiting_agent','queued')`, so a lapsed offer was invisible, the
name block was skipped entirely, and the reply fell to `tryLateClaim` ->
`matchLateClaimReply`, which had no name matching and picked the newest
`updated_at`. A `sleep` step waking on an unrelated run re-sorted the list.
The typed name was then stamped as the ETA, texting the owner
"ETA to contact lead: Aurora Anthony" and zeroing
`claimed_agent_eta_minutes` (which also disables the first-to-claim yank).

**How it works now**, in `_shared/ai_flows/late_claim.ts`:

- `classifyCandidate` decides eligibility per row; `matchLateClaimReply`
  returns a resolution (`match` / `ambiguous` / `none`), not a nullable match,
  because ambiguity has to ASK.
- A resolved NAME beats recency and beats bucket precedence.
- `collapseByLead` groups by folded name FIRST, and the phone splits a group
  only when it can. Keying on name+phone was Bugbot's finding: Amy's chained
  flows do not all capture a phone (`lead_phone` is `"none"` or `""` on real
  rows), so one lead split in two and asked
  "Aurora Anthony (...0022) or Aurora Anthony".
- A NAMED reply may yank; the bare-"1"-only rule was only ever a proxy for
  "no ETA".
- A text naming nothing is still an ETA, so "1, 20 min" is unchanged.

**How to apply:** when a lead-picking mechanism gains a smarter input, find
every path that consumes that input, not just the one you were looking at.
The live path and the late path are two consumers of the same reply. Related:
[[project_bare_digit_claim_is_lifo]], [[project_claim_by_reply_one_two_paths]],
[[feedback_check_for_a_shared_mechanism_first]].
