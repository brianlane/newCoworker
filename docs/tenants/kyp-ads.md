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
| Roster | none: James is the only human in the loop |

Build spec: [PRDs/white-glove-build-kyp-ads.md](../../PRDs/white-glove-build-kyp-ads.md).
Incident review: [docs/INCIDENT-2026-07-KYP-ONBOARDING.md](../INCIDENT-2026-07-KYP-ONBOARDING.md).

## How leads arrive

Meta lead ads fire a webhook; the AI texts the lead and drives toward a
Calendly booking. Most of what can go wrong on this account is a booking-state
problem rather than a messaging problem.

## Flows

| Flow | State | Note |
| --- | --- | --- |
| Lead follow-up (white-glove build, webhook, 16 steps) | on | The main path. Offer selection lives on the webhook trigger condition (payload contains the Simple-form name); the in-flow $100/$200 branch from one-shot #715 was removed in an unledgered Jul 19-24 reshape, and live is canonical (`kyp-lead-flow-definition.ts`). Bad-phone intake arm: an undialable lead number emails the lead and tells James instead of dying at the greeting (`patch-kyp-bad-phone-intake.ts`) |
| Booking confirmation (SMS + email, webhook, 5) | on | Shape lives in `kyp-reminder-flow-definition.ts` |
| Pre-call reminder, 1hr before (calendar, 3) | on | Same builder as the booking confirmation |
| No-show recovery text (calendar, 3) | **on** | Live since 2026-08-01, and it has sent. The row still says "awaiting approval" in its own name because James never approved it going live: treat that as an open question for him, not as a reason to flip it off. Fires only for no-shows marked in Calendly within 2h |
| Wrong-link booking flag (calendar, 2) | off | Blocked on the warm list |
| Proposal send + follow-up (manual, 6) | off | Awaiting approval; James triggers it manually |

Two flows (wrong-link flag, proposal send) sit **deliberately off pending
owner approval**. Do not "fix" them by enabling them.

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

## One-shots

Onboarding: `provision-kyp-ads-retry.ts`, `assign-kyp-ads-did-438.ts`,
`apply-kyp-intake.ts` (the white-glove intake applied to the tenant),
`send-kyp-live-sms.ts`.

Flow definitions: `kyp-lead-flow-definition.ts` (previously named
kyp-offer-definition.ts), `kyp-noshow-definition.ts`,
`kyp-reminder-flow-definition.ts`.

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
