# KIN Integrated Child Health (Kingsley Moyo)

Business id: `a912aff5-dd87-49fb-ad6a-477acefb66c0`. Standard tier, monthly,
signed up self-serve 2026-08-24 after a re-issued payment link (the first
checkout was abandoned Aug 21; the payment-link tooling in PR #1591 exists
because of this account). Box `srv1864812` (the pool KVM 2). Timezone
America/Edmonton. Priority support until ~2026-09-23 (James-referral deal:
white-glove and build fees waived, 30 days priority support).

## Identity

Edmonton child/adolescent clinic: speech therapy, occupational therapy,
psychology, nurse practitioner, behaviour consulting. Owner Kingsley Moyo.
The canonical business name is **KIN Integrated Child Health** (matches the
business row and the Meta lead form). The white-glove intake said "King
Health Services"; that name is metadata only and appears nowhere in the
tenant's knowledge or copy.

Kingsley also owns a second, separate clinic (Live Collective Counseling, sex
therapy) discussed on the Aug 20 discovery call as a likely second account
later. Keep the two strictly apart; nothing for it lives here yet.

Referred by James (KYP Ads), who runs the Meta ads. Same referral shape as
Scar Fairy: James is both a tenant and the ad operator for tenants he refers.

## Compliance posture

Agreed on the discovery call and recorded in the HQ transcript doc: New
Coworker is NOT HIPAA certified; this tenant handles prospective leads only,
never clinical data on existing patients. `hipaa_mode` stays OFF (owner
decision 2026-08-24, and it is not an enterprise account). The soul already
forbids collecting minor-child details beyond "is this for yourself or
someone else".

Texting consent: the Meta lead form is named "KIN Integrated - Free 15 Minute
Consult (Consent)" and carries the consent capture; the intake's
`consent_confirmed: not_yet` predates that form. Working assumption
(2026-08-24): form-level consent is the express consent to text, the first
SMS names the clinic, and platform STOP handling covers opt-out.

## How leads arrive

Meta lead ads, relayed by James's Zapier bridge ("Send Lead to Coworker",
the `send_lead` action) to `POST /api/public/v1/flow-events`. Bridge-only:
there is NO `meta_connections` row, same posture as KYP and Scar Fairy. The
Zap authenticates with the API key minted by `mint-kin-zapier-key.ts`
(name "Zapier (Meta leads via KYP)").

Known form: "KIN Integrated - Free 15 Minute Consult (Consent)", form id
`1938141376869131` (texted by James 2026-08-24). The flow trigger is
deliberately unconditioned (single form today); add `form_name` routing if a
second form with different handling lands, and note the Scar Fairy caveat:
a switch to the direct Meta connection would deliver `form_id` with no
title, so name-based routing would break.

## Flows

Read live: `tsx debug/flow-poll.ts a912aff5-dd87-49fb-ad6a-477acefb66c0`.

One flow: **"Lead follow-up (white-glove build)"**, installed by the
white-glove apply on 2026-08-24, **disabled**. It stays disabled until BOTH:

1. Kingsley approves the wording, and
2. the JaneApp links are in place. Done 2026-08-25: the applier's
   placeholder refusal no longer trips, so only the wording approval
   remains.

Shape after `patch-kin-lead-flow.ts`: extract -> upsert customer -> greeting
SMS naming the clinic with the JaneApp link -> instant owner alert -> nudge
at 2h -> nudge next day -> after a final unanswered day, owner "personal
touch" alert + tag Inactive. Lead-facing sends hold to 09:00-20:00
America/Edmonton; owner alerts are instant. Cadence is the intake's own
(first_follow_up 2h, second next_day, handoff after 2 attempts).

## Booking

**JaneApp link handoff, no calendar integration.** Same pattern James used
before Calendly allowed two app integrations: the coworker hands out the
booking link, booking itself happens in JaneApp. JaneApp has no integration
today (Zapier-only, revisited on the Aug 20 call as a possible future
first-class integration).

### The pages, and how a lead reaches the right one

Kingsley's booking site (2026-08-26). The table lives in
`scripts/oneshot/kin-booking-links.ts`, imported by BOTH halves of the
routing so they cannot drift:

| Need | Page |
| --- | --- |
| Occupational therapy | `.../#/occupational-therapy` |
| Psychological assessment | `.../#/psychological-assessment` |
| Counselling, ages 3-12 | `.../#/child-counselling-ages-3-12` |
| Counselling, ages 13-17 | `.../#/teen-youth-counselling-ages-13-17` |
| Counselling, adults | `.../#/adult-counselling` |
| Couples counselling | `.../#/couples-counselling` (coworker only, the form cannot produce it) |
| Speech / SLP | no page: waitlist, send no link |
| Anything else, or unknown | `https://kinintegrated.janeapp.com/` |

**Routing is SERVICE-first, with age nested inside counselling.** That shape
is load-bearing, not tidiness. `lead_notes` concatenates both form answers,
and the v3 form's age value `teen_13_to_17` contains the substring "teen".
A flat service-level match on "teen" was therefore hijacked by the AGE
field: `occupational_therapy` + `teen_13_to_17` routed a 15-year-old needing
OT to counselling. Simulated across the v3 matrix before the ads switched,
5 of 12 combinations mis-routed. Service now decides the discipline, and age
only sub-routes within counselling, which is the one age-split discipline.
So the collision is structurally impossible rather than merely avoided.

Both form generations are handled while the ads switch over: v1 sent labels
("My child (12 and under)"), v3 sends keys (`child_12_and_under`), and the
tokens `child` / `teen` / `adult` appear in both.

Routing happens twice, because a lead can say what they need at two moments:

1. **Proactive, in the flow.** `s_route_booking` branches on the service
   answer, and `s_route_age` nested inside the counselling arm branches on
   age. Deterministic, no model call. Each arm matches ONE token because
   `MAX_BRANCH_ARMS` is 4 and a `when` takes exactly one comparator, so an
   arm cannot OR several phrasings. A test asserts the live arm conditions
   equal those tokens.
2. **Reactive, in the coworker.** The moment a lead replies, the SMS
   coworker owns the conversation (Kingsley's plan: "if they reply the ai
   worker will nurture"). It reads the same table out of `identity.md`.

**Counselling pages turn away the wrong age group**, so a counselling
enquiry with no usable age answer is NEVER guessed into one: the flow sends
the general page and asks whether it is for a child, a teenager or an adult,
and the coworker is told to ask before sending any counselling link.

**The 13-year-old gap is closed.** Child ended at 12 and teen began at 14,
so 13 had no bookable page regardless of how the form was labelled (raised
by James 2026-08-25). Kingsley extended the teen service down to 13, which
also changed its slug from `...-ages-14-17` to `...-ages-13-17`. The old
slug is retired and a test asserts it appears nowhere.

**Speech / SLP is a WAITLIST, by design** (Kingsley, 2026-08-26). There is no
booking page and there will not be one until that changes, so a speech lead
is sent NO link, not even the general page: offering one invites a booking
they cannot make. The flow's speech arm says plainly that speech is on a
waitlist and that the team has been told, and the owner alert every lead
already fires is what gets them onto the list. The coworker carries the same
rule and is told not to promise a date.

A waitlist lead is also held OUT of the nudge cascade (`s_followups` gates
it). Every nudge is booking copy carrying the general link, so nudging a
speech lead two hours after telling them there is nothing to book would undo
the rule. `contains` has no negation, so the waitlist arm holds the
cascade's absence and the else holds the cascade. `s_goal` stays on the main
path after the gate, because a goal may not sit inside a branch.

The pre-branch owner alert deliberately does NOT say what the lead was sent:
it fires before routing (so quiet hours cannot delay it) and therefore
cannot know, and a speech lead receives no link. The Details line carries
the service, which is what tells Kingsley to add them to the list.

He also said the current ads are not running SLP yet, so that arm is dormant
until James turns it on. Built now rather than left to be remembered.

**Link fragments are load-bearing.** All three specific pages are `#`
fragment URLs. The SMS shortener matches `https?://[^\s<>"']+`, so the
fragment survives shortening and the 302, but a period placed directly after
a link gets swallowed into the URL and JaneApp 404s on it. Every link in the
flow copy and in the knowledge therefore ends its own line.

Consequences, accepted knowingly:

- Nothing observes a JaneApp booking, so the `appointment_booked` goal and
  the booking precheck are inert. A lead who books but never replies still
  gets both nudges; nudge 2 says "If you already booked, you are all set" so
  that reads polite rather than broken.
- The dashboard cannot show KIN bookings. Conversion tracking (a thing
  Kingsley explicitly wants; he described losing count between "30
  conversions" and 20 bookings) currently ends at "replied".

## Roster

Empty, deliberately (2026-08-24). Kingsley IS the account owner, so the
implicit-owner rule already routes alerts and contact ownership to him; an
`employees` row would add nothing until a real second person exists. The
intake names an Intake Coordinator role with his cell (780-800-3760, also
`forward_to_e164` for warm transfers); add that person to the roster when
they are a distinct human.

## Numbers

- DID: Alberta number via `swap-kin-did-alberta.ts` (2026-08-24). Provisioning
  originally bought +1 519 937 9510 (Ontario) because `preferred_area_code`
  was null; swapped before anything was published. The swap preserves
  `forward_to_e164` and releases the 519 number at Telnyx.
- Owner cell / transfer target: 780-800-3760 (from the intake team line).
  The business row's owner phone is a different 780 number; both are his.

## Sharp edges

- **Two pending subscription rows** predate activation (Aug 21 abandoned
  checkout, Aug 24 re-issued link). The newest row is the active one; the
  Aug 21 `pending` orphan is harmless and expected (see PR #1591's row-reuse
  fix, which prevents new ones).
- **The flow being OFF is on purpose** until wording approval + real link.
  Do not "fix" it by enabling.
- **Speed-to-lead vs quiet hours:** an evening Meta lead gets the owner
  alert instantly but the greeting waits for 09:00 if it lands after 20:00
  Edmonton. That is the chosen trade; revisit with Kingsley if he wants
  later texting.

## One-shots

- `kin-booking-links.ts`: the four JaneApp links and `resolveKinService`,
  the single source of truth both routing halves import.
- `kin-lead-definition.ts` (pure builder, pinned by
  `tests/oneshot-kin-definitions.test.ts`)
- `patch-kin-lead-flow.ts`: canonical flow copy (typo fixes, clinic name,
  JaneApp link, quiet hours). Refuses to apply while the link is a
  placeholder. Leaves `enabled` untouched.
- `kin-knowledge-content.ts` + `patch-kin-knowledge.ts`: writes the booking
  links into `identity.md` (so the coworker can hand out the right page on a
  reply) and repairs the typo'd white-glove greeting block in `soul.md`.
- `mint-kin-zapier-key.ts`: mints the Zapier bridge API key for James.
- `swap-kin-did-alberta.ts`: 519 -> Alberta DID swap + old-number release.

## History

- 2026-08-20: discovery call (transcript in HQ documents; pricing bullet in
  that doc corrected by `fix-hq-discovery-doc-pricing.ts`). White-glove
  intake sent same day.
- 2026-08-21: intake completed 06:41; self-serve signup abandoned at Stripe
  21:35 UTC.
- 2026-08-25: Kingsley sent three service booking links plus a general one;
  routing built in both the flow and the coworker knowledge. He also stated
  the operating model: text leads the links, follow up only on no reply, and
  let the coworker nurture anyone who replies.
- 2026-08-24: asked for a payment link by SMS, the HQ coworker sent the
  questionnaire instead (root cause of PRs #1589/#1591/#1593); paid via
  re-issued link 15:20 UTC; provisioned onto srv1864812; white-glove build
  applied 18:52 UTC (flow installed disabled).
