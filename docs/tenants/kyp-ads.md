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
| Lead follow-up (white-glove build, webhook, 14 steps) | on | The main path. Offer routing branches on the Facebook lead form name (one-shot #715) |
| Booking confirmation (SMS + email, webhook, 5) | on | |
| Pre-call reminder, 1hr before (calendar, 3) | on | |
| No-show recovery text (calendar, 3) | off | Awaiting James's approval. Fires only for no-shows marked in Calendly within 2h |
| Wrong-link booking flag (calendar, 2) | off | Blocked on the warm list |
| Proposal send + follow-up (manual, 6) | off | Awaiting approval; James triggers it manually |

Three flows sit **deliberately off pending owner approval**. Do not "fix" them
by enabling them.

## Sharp edges

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

Flow definitions: `kyp-offer-definition.ts`, `kyp-noshow-definition.ts`.

Patches: `patch-kyp-offer-branch.ts`, `patch-kyp-business-hours.ts`,
`patch-kyp-noshow-links.ts`, `patch-kyp-calendar-contact-filing.ts`,
`enable-kyp-reply-alerts.ts`, `set-kyp-booking-email-sender.ts`,
`reenroll-kyp-canceled-runs.ts`, `backfill-calendly-booking-goals.ts`,
`fix-kyp-kav-contact.ts`, `mark-lead-spam.ts`, `undo-spam-flag.ts`,
`strip-em-dashes-flows.ts`, `rename-phone-named-gate-fields.ts`.

The last one renames the booking flow's `has_phone` gate to `lead_reachable`.
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
