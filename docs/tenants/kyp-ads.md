# KYP Ads

Our first full white-glove build, and the account whose onboarding produced a
written incident review. Calendly is the center of gravity here.

## Identity

| | |
| --- | --- |
| Business id | `056034a7-e84c-444d-8d15-747eeb1fa899` |
| Tier / box | standard, VPS `1869876` (term-renewal cutover 2026-07-31 from `1864812`, which had itself replaced `1800985` on 2026-07-29). Hostinger billing sub `169qOAVQwnrcE14n3`, next billing 2026-08-31 |
| DID | `+14388035806` (Canadian) |
| Owner | James Lee |
| Onboarded | 2026-07-14 |
| Roster | James Lee (`+852` mobile, Hong Kong, no email on the row; NOTE the +852 SMS sharp edge below, so any flow step texting this roster row goes dark). Liz (the VFM assignee) joins when `apply-vfm-team.ts` runs with her phone |

Build spec: [PRDs/white-glove-build-kyp-ads.md](../../PRDs/white-glove-build-kyp-ads.md).
Incident review: [docs/INCIDENT-2026-07-KYP-ONBOARDING.md](../INCIDENT-2026-07-KYP-ONBOARDING.md).

## How leads arrive

Meta lead ads fire a webhook; the AI texts the lead and drives toward a
Calendly booking. Most of what can go wrong on this account is a booking-state
problem rather than a messaging problem.

## Flows

Live snapshot 2026-08-10 (5 on / 8 total). The VFM flow joins this table
when `seed-vfm-lead-aiflow.ts` runs.

| Flow | State | Note |
| --- | --- | --- |
| Lead follow-up (white-glove build, webhook, 16 steps) | on | The main path. Offer selection lives on the webhook trigger condition (payload contains the Simple-form name); the in-flow $100/$200 branch from one-shot #715 was removed in an unledgered Jul 19-24 reshape, and live is canonical (`kyp-lead-flow-definition.ts`). Bad-phone intake arm: an undialable lead number emails the lead and tells James instead of dying at the greeting (`patch-kyp-bad-phone-intake.ts`) |
| Booking confirmation (SMS + email, webhook, 5) | on | Shape lives in `kyp-reminder-flow-definition.ts`; trigger: webhook payload contains `calendly_booking` |
| Pre-call reminder, 1hr before (calendar, 3) | on | Same builder as the booking confirmation. `event_start`, 60 min lead, scoped to events containing "KYP Ads \| Free Strategy Call", so the VFM flow's T-60 confirmation never overlaps it |
| No-show recovery text (calendar, 3) | **on** | Live since 2026-08-01, and it has sent. The row still says "awaiting approval" in its own name because James never approved it going live: treat that as an open question for him, not as a reason to flip it off. Fires only for no-shows marked in Calendly within 2h |
| Follow-up send: Stefan, Windshield Place (manual, 1) | on | One-off manual send_email |
| Proposal follow-up, email (tag_changed, 8) | off | Fires on the `proposal-sent` tag when enabled |
| Wrong-link booking flag (calendar, 2) | off | Blocked on the warm list |
| Proposal send + follow-up (manual, 6) | off | Awaiting approval; James triggers it manually |

The off flows (proposal follow-up email, wrong-link flag, proposal send) sit
**deliberately off pending owner approval**. Do not "fix" them by enabling
them. Flow NAMES can carry stale state notes ("awaiting approval"); the
`enabled` bit is authoritative, the name is not.

## Second brand: Vantage Flow Media (VFM)

Since Aug 2026 this tenant serves TWO of James's businesses. Vantage Flow
Media (VFM) is his second lead-gen agency, run inside the KYP tenant by
explicit decision: same login, same DID, same box, no new business record,
standard features only. Liz (the VFM assignee, US Eastern) runs the VFM
strategy calls; James is in Hong Kong, so VFM replies must page her, not him.

How the pieces fit:

- **Persona:** the coworker presents as the owner's assistant serving both
  brands and never asks which business a contact means. Marker-delimited
  sections in `identity_md` (VFM facts) and `soul_md` (two-business rules),
  applied by `apply-vfm-brand.ts`.
- **PRICE SILENCE:** VFM is testing three management price points, and no
  surface may quote one (the AI cannot know which offer a lead saw). The
  price points live nowhere in the vault or flow copy, by design; only the
  $30/day ad-spend floor is sayable. Enforced by
  `tests/oneshot-vfm-definitions.test.ts`.
- **Brand separation at the trigger:** the VFM flow claims the three VFM
  Meta form names via OR'd webhook triggers; KYP's lead flow keeps
  "Simple form setup 5/7/26". Same mechanism, different `contains` values.
- **Lead handling:** VFM leads are tagged `VFM`, and `route_to_team` pinned
  to Liz hard-assigns them (`businesses.lead_auto_assign = true`, the Truly
  Issue 7 machinery; no other KYP flow uses route_to_team, verified before
  flipping). Ownership is what redirects `sms_customer_reply` pages to Liz.
- **No booking integration, on purpose:** VFM books on Liz's own Calendly
  (`calendly.com/elizabethastone/30min`), which this tenant's Calendly
  connection cannot see (one connection per business, and it is James's).
  The T-60 confirmation gets its time from the lead's replies via the
  run_agent parser ("VFM booked-time parser" in business_agents). A lead
  who books silently gets no confirmation; accepted.
- **Timezones:** VFM nudge quiet hours are gated per-flow in
  America/New_York; the business timezone stays America/Toronto, so KYP's
  flows are unaffected.

## Sharp edges

- **This account's leads are not all North American, and the calendar flows
  once assumed they were.** 2026-08-05, Reem (`Europe/London`): the pre-call
  reminder told her a 13:00Z call was "2:00 PM Eastern time (your local
  time)". It was 2:00 PM UK. She was later told no call was starting while
  hers was seven minutes away, and she canceled. Cause: `invitee_tz_plain`
  asked the extractor for a zone from a five-item **North American** list and
  said to return 'Eastern' when unclear, so a London invitee had no correct
  answer available. The trigger payload was right the whole time
  (`invitee timezone: Europe/London`). Same defect class as Ayanna on
  2026-07-20, whose fix (PRs #810/#814/#824) reached `calendar-tools` and
  `contact-booking-context` but not the AiFlow extraction surface. Customer
  copy now says "your time" and names no zone at all, because
  `invitee_local_time` IS the invitee's wall clock; only the owner notify
  carries a zone, copied verbatim as an IANA id. Pinned by
  `tests/e2e/kyp-invitee-timezone-label.e2e.test.ts` (live) and the hermetic
  block in `tests/oneshot-kyp-definitions.test.ts`. James is relocating to
  Hong Kong, so assume international invitees are normal here.
- **If James switches his owner phone to a Hong Kong (+852) number, every
  SMS to him goes dark and stays dark.** Telnyx confirmed (ticket #557577,
  Aug 2026) that our long codes cannot originate SMS outside NANP at all,
  and Telnyx sells no SMS-capable HK numbers, so two-way SMS to +852 is
  unachievable on this account (README, "International reachability").
  What still works: voice forwarding and warm transfer to a +852 number
  (the outbound voice profile whitelists HK; watch the fleet-wide $25/day
  voice spend limit), email, dashboard alerts, and WhatsApp, which KYP has
  NOT connected yet (no `whatsapp_connections` row). Before or when he
  switches: get his WhatsApp connected so owner alerts have a two-way
  channel, and expect the dashboard's deliverability warnings on the
  profile, alert-phone, and forwarding surfaces, which are correct, not a
  bug. A registered one-way alphanumeric sender (application drafted Aug
  2026) may later restore outbound-only SMS alerts to HK.
- **Calendly event-type names carry the price tier, and renaming one breaks a
  flow silently.** `my-free-scale-plan` is titled "KYP Ads | Free Strategy
  Call" ($100/wk); `kyp-ads-free-strategy-2` is titled "KYP Ads | Free
  Strategy Call | **Client**" ($200/wk). The no-show flow still branches on
  the string `"free strategy call | 2"`, which no live event type matches
  any more, so a $200 no-show falls through and is texted the $100 link,
  which the wrong-link flow explicitly forbids. Latent so far: both runs to
  date (Jul 20, Aug 1) were genuine $100 events.
- **The Canadian DID is not incidental.** Auto-DID assignment failed for a
  Canadian owner during onboarding, and `TELNYX_MESSAGING_PROFILE_ID_CA` being
  unset in local runs is a documented trap. Anything touching DID assignment
  or messaging profiles should be tested against a CA number, not just a US
  one.
- **Booked-then-enrolled was a real bug here.** A lead who had already booked
  kept getting nurture texts. The fix is the synchronous booking precheck plus
  a widened sweep (PR #770); if you change enrollment, keep
  `tests/worker-integration/calendly-booking-goal-gap.itest.ts` passing.
- **Business hours gate this account's sends** (PR #770,
  `patch-kyp-business-hours.ts`). A change that ignores quiet hours will text
  James's leads at night.
- **Noise reduction was a deliberate campaign** (PR #795): short-link AI
  replies, an `event_end` thread-activity guard, booking-status context. James
  notices chattiness.
- **This account has both `mark-lead-spam.ts` and `undo-spam-flag.ts`
  applied.** Spam flagging has been used and reversed here, so check
  `flag_contact_spam` state before concluding a lead is being ignored.
- **The box was adopted from a pool**, and the adopted box once served the
  previous tenant's tunnel (`rowboat_http_530`). The adoption-pool checklist
  in the incident doc exists because of this account.
- **2026-07-29 term-renewal cutover:** overnight sweep bought `1864812`
  (fail-but-charge orphan) instead of renewing `1800985` (~43% savings).
  Orchestrator stalled at 40% (`remote_deploy_starting`); cutover was finished
  manually (restore, billing repoint, old box stop + auto-renew off + pool
  `never_renew`, provisioning marked 100% without owner SMS). Owner notify
  on background migrations is now suppressed via `suppressOwnerNotify`
  (PR #1011).
- **2026-07-31 term-renewal cutover, two days later, and it should not have
  happened.** The 11:01 UTC sweep bought `1869876` and moved KYP again, then
  pooled `1864812` with `never_renew`. Third box in three days for this
  tenant, and `1864812` was stranded barely two days into a paid month. Cause:
  the renewal window was 30 days, but a monthly Hostinger box is never more
  than ~30 days from its next bill, so the box the sweep had just bought
  re-qualified immediately. Scar Fairy was hit by the same bug on 2026-07-30.
  Fixed in two parts: PR #1039 narrowed the window (now 36 hours, so the sweep
  moves a tenant about a day before renewal), and the purchase cooldown means
  a tenant we bought a box for in the last 7 days is never bought another.
  **When reading this account's history, do not assume one box per month:
  check `vps_inventory` for how many boxes carry this business id.**
- **2026-08-06 Canada-whitelist outage: this tenant is the fleet's canary
  for Canadian traffic.** The Aug 5 profile-widening one-shot replaced
  every Telnyx whitelist with a dial-table-derived list that cannot
  contain CA (bare +1 maps to US), so all SMS to Canadian numbers failed
  with Telnyx 40309 from Aug 5 ~15:00 UTC until the profiles were
  re-patched Aug 6 ~20:30 UTC. Only KYP was hit: 22 errors, all Aug 6
  15:03 to 19:51 UTC, being notify_owner alerts to James's forwarding
  number and the lead follow-up to lead H Eve, which never sent. The widen
  script now unions instead of replacing and refuses a list without
  US/CA/MX (`scripts/oneshot/widen-telnyx-allowlist.ts`). If a Canadian
  send fails with "Invalid destination region 'CA'" again, check the
  profile whitelists first.

## One-shots

Onboarding: `provision-kyp-ads-retry.ts`, `assign-kyp-ads-did-438.ts`,
`apply-kyp-intake.ts` (the white-glove intake applied to the tenant),
`send-kyp-live-sms.ts`.

Recovery: `requeue-failed-flow-run.ts` (generic; applied here Aug 6 2026 to
re-run the lead flow for H Eve after the Canada-whitelist outage killed run
4e9fdf3c at its first customer text).

Vantage Flow Media rollout: `apply-vfm-brand.ts` (vault sections + sync),
`apply-vfm-team.ts` (Liz on the roster + `lead_auto_assign`),
`seed-vfm-lead-aiflow.ts` (parser agent + the VFM lead flow). Content and
flow shape are pinned by `tests/oneshot-vfm-definitions.test.ts`.

Flow definitions: `kyp-lead-flow-definition.ts` (previously named
kyp-offer-definition.ts), `kyp-noshow-definition.ts`,
`kyp-reminder-flow-definition.ts`,
`vfm-lead-flow-definition.ts` (seeded by `seed-vfm-lead-aiflow.ts`).

`kyp-reminder-flow-definition.ts` is the canonical shape for the two
calendar-side flows, "Pre-call reminder (1hr before)" and "Booking
confirmation (SMS + email)". Neither had a repo copy before 2026-08-05, which
is how the Reem timezone defect above survived a platform fix aimed at the
same failure mode: there was nothing to grep, review, or test. Captured from
live and verified byte-for-byte against the `ai_flows` rows, so any future
change belongs in the builder and reaches the tenant through a one-shot.

Patches: `patch-kyp-timezone-labels.ts`, `patch-kyp-noshow-event-title.ts`,
`patch-kyp-cancel-tool-policy.ts`, `patch-kyp-business-hours.ts`,
`patch-kyp-noshow-links.ts`, `patch-kyp-calendar-contact-filing.ts`,
`enable-kyp-reply-alerts.ts`, `set-kyp-booking-email-sender.ts`,
`reenroll-kyp-canceled-runs.ts`, `backfill-calendly-booking-goals.ts`,
`fix-kyp-kav-contact.ts`, `mark-lead-spam.ts`, `undo-spam-flag.ts`,
`strip-em-dashes-flows.ts`, `rename-phone-named-gate-fields.ts`,
`patch-kyp-bad-phone-intake.ts`.

`patch-kyp-bad-phone-intake.ts` is the Aug 1 2026 undialable-lead fix: a
Facebook lead typed a `+1` number with three stray extra digits (13 national
digits, structurally E.164, impossible in NANP) and the greeting send died at
Telnyx (400/40310) with the owner-notify step behind it. The engine now
scrubs impossible `+1` numbers to "none" (`coerceDialableE164`), and this
patch gives the flow a designed no-phone path: notify James, email the lead
the booking link, skip the reply ladder. The same PR reconciled
`kyp-lead-flow-definition.ts` to the live shape after an unledgered Jul
19-24 reshape had made the old builder stale (live is the source of truth;
the stale applier patch-kyp-offer-branch.ts was retired, see the Removed
section of scripts/oneshot/README.md).

`rename-phone-named-gate-fields.ts` renames the booking flow's `has_phone`
gate to `lead_reachable`.
`has_phone` holds "yes"/"no", but `isPhoneFieldName` matches any phone token in
a field name, so the phone-field validator added in PR #885 rewrote both values
to "none" and would have killed the `confirm_sms` and `file_contact` steps on
the next run. The flow had not fired since Jul 23 2026, so it was caught while
still latent, unlike the same bug on Amy's ReferralExchange flow. Check for the
shape with `tsx debug/audit-phone-field-names.ts`.

## History

PRs #617, #641, #693, #715, #756, #768, #770, #795, #1011. Diagnostics:
`debug/diag-kyp-box.ts`, `debug/fix-kyp-tunnel.ts`,
`debug/kyp-calendly-zoom-check.ts`.
