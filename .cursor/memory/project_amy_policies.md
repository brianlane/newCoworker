---
name: amy-policies
description: "Amy Laidlaw tenant policies: seller calls, under-500K AI-owned gate, SMS and email follow-up cadences, open findings incl. Aug 23 notification-fields ask (saved to memory, intake SMS ignores it)"
metadata: 
  node_type: memory
  type: project
  originSessionId: f92ec33f-e800-4569-9e1b-d63077b2e8c1
  modified: 2026-08-24T21:24:49.442Z
---

## project_amy_seller_call_policy

Amy Laidlaw (business `621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`) gave direct
guidance on 2026-08-05 for what her AI coworker says on outbound seller calls
and voicemails across all three seller sources (Clever, ReferralExchange /
RealEstateAgents.com, HomeLight):

- **The motive is to win the listing, not to collect data.** In her words it
  is "about winning the lead and not about information extraction". So these
  call steps carry no `captureFields`; the automatic post-call summary and
  transcript are the record.
- **Never ask when is a good time to call back**, and never propose a callback
  time. She wants to call back fast, not to an appointment. This contradicts
  the live New Lead Intake flow, whose `CALL_CAPTURE_FIELDS` includes "best
  time to reach them" (`scripts/oneshot/seed-amy-new-lead-intake.ts`).
- **Four talking points, in order:** name the team, source, and property; an
  appraiser on the team who prices precisely and stops lowballs; low flexible
  commissions with the seller's bottom line first; neighborhood comparables to
  be emailed over.
- **Clever gets an extra angle, and it is her edge.** Clever markets on its
  cash-offer program and instructs her to mention it and quote the offer
  amounts, then argue that listing nets more than a quick cash sale. The other
  sources get the shorter script with no cash-offer content.
- **Comparables are promised on every call and fulfilled by Amy by hand.**
  Nothing automated sends them. She chose this knowingly; it is the promise
  most at risk as call volume rises.
- **If the lead asks for Amy or a teammate**, the AI offers to get them on the
  line. If nobody answers it says it has left them a message (an SMS to the
  team, never a voicemail) to call the lead back, points the lead at
  PhoenixAreasBestRealtor.com, and closes.
- **Voicemails must include her number (602-695-1142)** and end with "looking
  forward to hearing back from you soon".

**Why:** these are her words spoken to her own leads at scale, and several of
them cut against what the platform would do by default (collect fields, book a
time, share one script across sources).

**Approved 2026-08-06** on the drafted pitch and voicemail scripts built from
this guidance. The approval covers CONTENT, not length: the voicemail drafts
run about 30 seconds, which fights both mailbox limits and how verbatim a live
model stays, so a measured verbatim benchmark still governs whether they ship
at full length.

**How to apply:** treat this as the spec for any seller-call persona or
voicemail script on her account. Related: [[project_aiflow_phone_field_trap]],
[[feedback_live_flow_source_of_truth]].

## project-amy-under-500k-gate

Shipped Aug 12-13 2026 (PR #1344, one-shot `amy-under-500k-ai-owned.ts`,
cadence reseed). Amy's rule: a SELLER lead priced under $500K, or with no
price at all, gets no team claim offer at arrival; the AI works it unclaimed.

**The moving parts, and where they live:**

- `price_gate` extraction ("ai"/"team") on all four lead flows. On the mixed
  flows the seller-only scope is IN the extraction (buyers always read
  "team"). Every guard fails toward the team: routes `notEquals "ai"`, gated
  extras `equals "ai"`, so an extraction miss reproduces the old behavior.
- Gated leads join the Needs Follow Up cadence BY TAG: AUTO_TAG_NOTE when a
  call just happened (round 1 skips to the 3-day wait), plain tag when not
  (the cadence's immediate call IS first contact, e.g. all of Realtor.com).
- Promotion is either signal: call_outcome "transferred" fires a claim offer
  on the spot (clever_route_promote / re_route_promote); the cadence
  classifies every reply and ready_to_talk earns the offer INSTEAD of the
  alert (first-match branch). Buyers promoted from the cadence keep rotation.
- Amy's second email on claim is NOT a new flow: it rides the
  `claimedNotifyEmail: amy@amylaidlaw.com` already on every route step,
  including the promotion routes.
- HomeLight EXEMPT (broadcast needed for the human-answered contact reveal,
  see [[project-homelight-own-claim-read-as-rival]]).
- $1M+ leads still go owner-direct: they always extract "team", so
  `ownerDirectWhen` is unreachable-safe by construction.

**The other half, Aug 13 2026 (PR #1356, `amy-team-unclaimed-ai-followup.ts`):**
a $500K-$1M seller whose claim offer runs its whole course unclaimed is ALSO
taken over: a `{p}_team_unclaimed` branch at the END of each lead flow waits
120min past flow end, re-checks `claimed_agent`, and tags into the cadence.
Every filter sits BEFORE the sleep (band as outer arm, lead-type wrapper,
claimed-skip on the sleep) so non-covered runs never park. $1M+ excluded
(ownerDirect = never offered, Amy personal). Realtor.com gained a
`lead_type` extraction: seller only when the message clearly says so.
Net: every unclaimed seller under $1M ends up AI-owned until ready.
Flagged, not built: "Follow Up Requested (Unclaimed Leads)" flow still ends
at "back to you" when unclaimed.

**Band is ARITHMETIC since Aug 14 (PR #1357, `amy-deterministic-price-band.ts`):**
a $613K lead was extracted price "$613K" AND price_band "over_1m" in ONE
call; three gates keyed on the judgment (no AI call, ownerDirect to Amy, no
takeover). Now every band gate keys on `price_under_1m`, computed by the new
`less_than` math op from `price_digits`. Call gates `notEquals "no"`,
ownerDirectWhen `equals "no"` (proven $1M+ only), takeover arms
`notEquals "no"`. Never re-introduce a gate on the extracted `price_band`.
The FUR flow ("Follow Up Requested") also has the takeover now
(`amy-followup-request-takeover.ts`, plain tag, no price_gate when since
nothing produces that var there).

**Wart:** gated Spanish NLI sellers ride the English cadence.

**Trap dodged:** Clever's retry ladder gates on `claimed_agent notEquals
"none"`, and the WORKER seeds claimed_agent="none" at every run start, so the
ladder still runs when the route step is skipped. Do not "fix" that seeding.

## project_amy_followup_cadence_rules

Flow `9c1dbf7f` "Needs Follow Up (AI cadence)" on Amy Laidlaw
(`621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`). Builder
`scripts/oneshot/amy-needs-follow-up-definition.ts`, applier
`seed-amy-needs-follow-up-aiflow.ts` (idempotent by flow NAME, re-run to
apply). Changed 2026-08-17, PR #1438.

**What stops the cadence now:** the lead replying (later rounds are gated on
`lead_reply` still being "no_reply", so "I already spoke with Dave" stops it
like any reply), the AI actually reaching them (`transferred`/`answered` empty
arms), and `appointment_booked`.

**A CLAIM no longer stops it.** Amy's rule: a claim is a teammate saying they
will work the lead, not evidence anyone was reached. `ROUNDS` came down 8 -> 3
in the same PR because the two are a pair: without the claim stop, 8 rounds
kept the AI calling an owned lead for 3+ weeks, past her "only three times".

**The booking stop is real but has almost no producer here.**
`calendar_book_appointment` is FALSE for sms, voice, webchat and email on this
tenant, true only for `dashboard` (re-verified 2026-08-17). So no
customer-facing surface can book. Amy DOES want AI booking (she welcomed a
2 PM appointment on Aug 17), so this is a toggle worth revisiting with her,
not a settled preference. Say "no customer-facing surface can book", never
"her AI cannot book": the dashboard Ask-AI companion can, and that is how she
saw one happen.

Booking alerts have a matching hole: dashboard/MCP bookings are EXCLUDED at
the call site (`bookSurface === "dashboard"` passes no `alertSurface`), on the
reasoning that the owner already knows what they booked. Combined with the
above, the public booking page is the only producer of a booking alert here.
See [[project_booking_alert_audience]].

**Traps:**

- `applyGoalEvent` is business-wide **by lead phone**, so the `claimed` event
  that used to end this cadence was usually raised by a DIFFERENT flow's
  `route_to_team`. Re-adding `{kind:"claimed"}` hands that power back.
- **Shrinking ROUNDS is an index migration.** `ai_flow_runs.current_step` is a
  flat index over the flattened definition and this flow always has runs parked
  mid-flight (9 on the day of the cut). Flatten live vs new with the engine's
  `flattenSteps` and check the first differing index is past the highest live
  `current_step` before applying. On Aug 17: identical to index 29, highest
  live step 13, all 9 runs unmoved.
- **Copy is selected by POSITION** (`copyForRound`), so the LAST round always
  signs off whatever ROUNDS is. Indexing by round number ends the cadence on a
  mid-sequence line promising more messages.
- The **Clever spoke check** (`dc073e9a`) keeps its `claimed` goal event on
  purpose: there a "claim" means a teammate confirming they SPOKE with the
  lead ("No AI follow-up calls will be made"), which IS Amy's rule. It also
  gates its rungs on `claimed_agent == "none"` separately.
- `route_to_team` checks `activeContactOwner` unconditionally before offering
  and assigns straight to the owner, so a cadence surviving a claim does not
  re-offer an owned lead to the roster.

Related: [[project_amy_under_500k_gate]],
[[project_late_claim_path_has_no_name_matching]], [[project_amy_seller_call_policy]].

## project_amy_email_followup_cadence

Shipped 2026-08-18, PR #1455, one-shot
`scripts/oneshot/amy-email-followup-cadence.ts` applied to ReferralExchange
Lead, Realtor.com Lead, New Lead Intake and Clever Lead - Accept. HomeLight
Referral excluded: it already runs its own three-rung email ladder.

**The gap it closes:** an email-only lead got ONE intro email and nothing
else. Every SMS/call step skipped because `sms_lead_type` and
`route_lead_type` read "none" without a phone option.

**Why it is not in the shared cadence:** see
[[project_contacts_are_phone_keyed]]. No contact row means no tag means no
tag-triggered flow.

**Shape** (`efu_*` step ids, appended to top-level steps, a pure append so
parked runs keep their `current_step`): gate on `lead_phone` not containing
"+" and `lead_email` containing "@", then an opening mailbox read, then three
rounds of wait/read/send a day apart.

**Design points that are load-bearing:**

- The opening read (`efu_check_0`) exists because the block sits at the END of
  the flow, after a team offer and a park that can last hours. Without it,
  round one's window opened a day after the sleep began and missed replies to
  the intro email.
- Reply detection is `email_extract`, NOT `wait_for_reply` (phone-only). It
  carries no `fromContains` on purpose: a bounce comes from a postmaster, so
  matching on the lead's ADDRESS APPEARING catches reply and bounce alike, and
  one Gemini field classifies (`replied`/`bounced`/`none`).
- `noMatchVars` on every read, or the whole ladder sits inert.
- Each round has its OWN stop var (`efu_stop_0..3`). A shared var is sticky
  once it reads "replied", so a flat cadence would re-alert on every later
  round. Per-round vars also carry the stop cascade without a branch per
  round, which matters because the schema caps branch nesting at 3 levels.

**Known bound:** `EMAIL_FETCH_MAX_MESSAGES` is 25 and `fromContains` filters
AFTER the fetch, so on a busy mailbox a reply can read as "none". Consequence
is one extra email plus no proactive alert; the reply is still in the inbox.
Fix, if it bites, is in `src/lib/ai-flows/email-fetch.ts`, which would change
behavior for every `email_extract` caller.

## project_amy_one_email_cadence

The three-round email follow-up for a lead with no phone existed **twice** for
about a day: inline at the end of the four lead-source flows, and inside "Needs
Follow Up (AI cadence)". That duplication is why tagging an email-only lead was
never switched on, since a tagged lead would have walked both and got six
emails.

**Since PR #1493 (applied 2026-08-19) there is one copy, in the cadence.** The
lead flows carry a four-step block instead:

```
efu_tag_root (no phone?) -> efu_tag_email_gate (has email?)
  -> efu_tag_file  (upsert_customer, keyed by the address)
  -> efu_tag       (update_contact, addTags ["Needs Follow Up"])
```

**The filing step is load-bearing, not decoration.** `update_contact` skips
when there is no contact row, so tagging alone would have depended on an
earlier `send_email` in the same run having succeeded (that is what files an
emailed lead). A skipped intro email would then silently end all outreach.

**Do NOT add `emailVar` to the flows' other `update_contact` steps.** They are
gated on `claimed_agent == none` or a call outcome, so they miss a claimed or
never-called lead, and they would enroll the same lead twice.

**Live proof it works** (2026-08-19): Valerie Marino and Jack Briggs are
email-keyed contacts, tagged, and their cadence runs sat at `efu_wait_1` with
`lead_phone=""` (not the `email:` key, thanks to
[[project_contacts_are_phone_keyed]]'s event-text fix). A lead WITH a phone
sits at `r1_wait` on the phone path, untouched.

**Removing steps is not index-safe.** `amy-email-followup-via-tag.ts` reads the
live runs per flow and refuses while any is parked at or after the block, in a
pass that completes before anything is written. Jack was parked inside it; the
migration was cancel his run, apply, then contact + tag so the cadence picked
him up. See [[project_amy_email_followup_cadence]] and
[[project_amy_followup_cadence_rules]].

## project_amy_notification_fields_ask_aug23

Verified live 2026-08-24. On Aug 23 Amy texted her coworker twice: include
buyer/seller, name, phone, email, website source, and price on notifications,
pasting two "New live-transfer lead (AI intake), the team missed the warm
handoff" alerts as the bad examples.

**What worked:** the owner-rule capture saved it. `business_configs.memory_md`
carries one deduped bullet under `### Owner chat (2026-08-23)` (her two
near-identical texts collapsed to one line, dedup working as designed).
Visible at /dashboard/memory.

**What did NOT happen:** nothing changed the alert itself. That SMS is a fixed
template in `vps/voice-bridge` (`composeIntakeLeadSms` in `src/intake.ts`):
header + AI-captured fields + "Transferred via" + transcript. It reads neither
memory_md nor flow vars nor the contact row. intake.ts untouched since Aug 18;
her `voice_handoff_chains` untouched since Jul 25 with `capture_fields` still
the standard five (no lead type, email, source, price); no one-shot, no PR. So
the next alert is identical, and the assistant's SMS reply ("Going forward,
all missed live-transfer and AI intake alerts will include...") promised a
behavior change the pipeline cannot deliver. Same pattern as her Aug 6
"include the property address" ask: memory saved it, but the real delivery was
an operator one-shot (`set-amy-lead-address-in-notices.ts`).

**Two defects the examples expose (outbound case):** both alerts were OUTBOUND
cadence calls to Clever leads that hit voicemail (AMD false negative), yet (a)
the header claims a missed live-transfer warm handoff, and (b) the lead's own
number rendered as "Transferred via" (+16232622189 = Isiah Perez,
+19098450027 = Linda Elenes; both have name/email/source on their contact
rows). The inbound-transfer safety rule ("ANI is the partner, never show as
callback") inverts on outbound calls, where the remote party IS the lead.

**How to apply:** the real fix is in the voice-bridge notify path
(`sendIntakeLeadSms`, `vps/voice-bridge/src/index.ts`): pass the flow/session
known lead details (voice_handoff_sessions.context has the flow_run link and
brief) or the contact row into the SMS, and label the outbound case honestly.
Optionally extend her chain's `ai_takeover.capture_fields` for live
conversations. Remember `vps/voice-bridge` needs its own tsc and a fleet
redeploy ([[project_voice_bridge_excluded_from_root_tsc]],
[[project_fleet_redeploy_check]]).

## project-amy-open-findings-aug11

Found during the Aug 11 2026 review of Amy Laidlaw Real Estate
(`621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`), all verified against live data, none
fixed yet. PR #1291 covered only the price-in-notices work.

1. **HomeLight Referral double-runs.** On Aug 11 2026 two runs 6s apart
   (15:43:54 and 15:44:00 UTC) both processed referral `hmlt.co/42a2915a`
   (seller "Marla", $507,258): both hit `route_to_team`, both texted Gabrielle
   Mota, both parked in a 60-minute `wait_for_reply`. The flow has
   `correlationWindowMinutes: 15` but NOT `options.dedupeLeadRuns`; only
   `Realtor.com Lead` sets that. See [[project-aiflow-phone-field-trap]] for the
   dossier's other flow traps.
2. **The ReferralExchange seller AI-call was never applied.**
   `amy-seller-ai-call-definition.ts` has a ReferralExchange variant, but the
   ledger shows `amy-seller-ai-call-patch.ts` applied twice (Aug 7 20:17 and
   22:48), both times against `Clever Lead - Accept` alone. Live
   `ReferralExchange Lead` has zero `place_ai_call` steps, so those sellers get
   no AI first contact. Closing it is `--only "ReferralExchange Lead"`, not new
   code. The dossier claimed both sources were live; corrected on PR #1291's
   branch, so this is lost if that PR never merges.
3. **`price_digits` extracts inconsistently.** The same HomeLight alert gave
   `507` in one run and `507258` in the other. Its description says "leading
   digits ONLY... for $264,000 answer 264", which is ambiguous for a
   full-precision figure. That field matches the lead to the portal alert email.

Related: [[feedback-live-flow-source-of-truth]],
[[project-fleet-redeploy-check]].
