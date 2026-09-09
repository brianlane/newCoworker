# Truly Insurance

Commercial insurance brokerage. The account that taught us the most about
answer quality: several model and prompt fixes in the platform were found by
reading Truly's transcripts.

**Wiped / out of the active roster.** The 30-day cancel-at-period-end grace
window ended, the grace wipe ran, and there is nothing left to watch. Do not
treat this tenant as live, and do not start a new grace-wipe watch.

## Identity

| | |
| --- | --- |
| Business id | `690f85c0-ee16-4ee5-bde5-5829df2e5410` |
| Status | `businesses.status=wiped`. Out of the active roster. |
| Tier / box | was standard, **boxless**. Hostinger pointers are null (`vps_id`, `subscription_id`, `post_install_script_id`). Former VPS `1815606` was detached 2026-07-29 and adopted by Scar Fairy |
| DID | **Released.** `telnyx_voice_routes` empty; `business_telnyx_settings.telnyx_sms_from_e164` null. Former number `+15198006401`. No further grace hold. |
| Owner | Muhammad Fahad |
| Onboarded | 2026-07-08 |
| Roster | Muhammad Fahad, Dania Shaikh, Awais Chauhan |
| Billing | `subscriptions.status=canceled`, `canceled_at` **2026-08-08**, `cancel_reason=user_period_end`. `grace_ends_at` **2026-09-07T22:27:42.88Z**. `wiped_at` **2026-09-08T00:15:05.524Z** (≈ 2026-09-07 5:15 PM America/Denver / MT). Not paused (`billing_paused` is the live column; do not set it). |

## Lifecycle (wiped, grace complete)

Truly canceled at period end. On 2026-07-29 we backed up their vault/memory,
nulled `businesses.hostinger_vps_id` and
`subscriptions.hostinger_billing_subscription_id`, and pooled vm `1815606` so
Scar Fairy could adopt it. Do **not** set `billing_paused` for this account;
product fixes (hardware-escalation advisor skips boxless tenants, PR #1016)
already stop the boxless alert email without a pause. `billing_paused` is a
Stripe pause-collection comp, not cancellation.

Verification dates:

- **2026-08-08**: Stripe period end stamped `canceled_at` and
  `grace_ends_at=2026-09-07T22:27:42.88Z`. No VM side effects (pointers already
  null). Re-checked 2026-09-02: Telnyx still held `+15198006401` as `active`
  (that was during grace, before wipe).
- **2026-09-07T22:27:42.88Z**: grace window ended. The DID was still reserved
  through grace on purpose so a reactivation would have kept the same line;
  `release_did` fires at wipe, not at cancel.
- **2026-09-08T00:15:05.524Z**: grace wipe completed. `businesses.status=wiped`,
  `subscriptions.wiped_at` stamped, DID released, `data_backups` row gone, all
  four AiFlows still disabled (0 enabled / 4 total). The PO grace-wipe watch
  routine is already deleted. No further watch.

Backup: the durable `data_backups` row is gone after the wipe. The pre-wipe
artifact (taken before the 1815606 re-image) lived in Supabase Storage bucket
`business-backups`, path
`backups/690f85c0-ee16-4ee5-bde5-5829df2e5410/latest.tar.gz`.

## How leads arrived

**Privyr sent lead-alert emails to a tenant mailbox**, which is why the main
flow's trigger is `tenant_email` rather than a webhook. Renewals, not new
leads, were the recurring business motion here. Inbound on the DID went
unanswered while boxless; that was accepted until wipe. The DID is now
released, so there is no live line.

## Flows

| Flow | State | Note |
| --- | --- | --- |
| Lead intake & follow-up (Privyr) (tenant_email, 7) | off | The main flow. HQ keeps a TEST COPY of it as the e2e harness fixture |
| Appointment reminder, 1 hour before (+ broker briefing) (calendar, 3) | off | |
| Appointment reminder, 24 hours before (calendar, 3) | off | |
| Post-appointment follow-up (calendar, 4) | off | |

**All four flows are disabled (0 enabled / 4 total).** That was deliberate
before the cancel. Do not re-enable them: the account is wiped.

## Sharp edges

- **HQ's e2e harness runs a copy of this tenant's flow.**
  `debug/flow-test-setup.ts` lays a TEST COPY of Truly's live Privyr flow on
  the HQ tenant with quiet hours widened. Changing the Privyr flow's shape can
  invalidate the harness, and vice versa.
- **Name handling has bitten twice.** The AI parroted full names back at
  customers, fixed by politely-cased first names (PR #823), and the Privyr
  first-name parse needed its own one-shot
  (`patch-truly-privyr-first-name.ts`).
- **Renewal replies are their own classification problem.** Renewal and
  final-check-in replies were being misread, and `wants_a_call` was too loose
  (PR #638). There was also a renewal-answer dead window, the Alex incident of
  2026-07-14 (PR #599), and the reply fork plus wait order both needed
  one-shots.
- **Answers used to truncate.** Truly's "D&O" question is the canonical repro
  for knowledge-lookup truncation on Gemini 3 (PR #658, fixed with minimal
  thinking). If lookup answers start getting cut off again, this is the test
  case.
- **Acknowledging is not acting.** A flow answered a question and then did
  nothing about the answer (PR #613, the Bryan/Amy incident, but the same
  class of bug shows up in Truly's follow-ups).
- **Never leave Truly's Hostinger billing pointers pointing at 1815606.** The
  Aug 8 `customer.subscription.deleted` webhook resolves the VM from those
  fields; left pointing, it would stop Scar Fairy's box. Pointers are null as
  of 2026-07-29 and stayed null through wipe.

## One-shots

**Em dash sweep (2026-08-18):** `strip-em-dashes-flows.ts --apply` cleaned the
live `ai_flows` copy for this tenant, closing the last gap left by the repo-wide
sweep in PRs #1474 and #1475. 4 flows, 7 copy fields: the 24-hour and 1-hour appointment reminders, the Privyr lead intake follow-up bodies, and the post-appointment status nudge. All four were `enabled=false` at the time, so no customer message changed mid-flight. Flow NAMES are untouched
by design: they are the lookup keys the one-shots resolve rows by. Re-running
the script now reports "No em dashes in any flow's copy fields".


**Voice infra (Aug 2026):** `migrate-tenants-to-dedicated-telnyx-apps.ts` moves
this tenant off the shared Telnyx Call Control app/profile onto a DEDICATED
app + outbound voice profile (both named with the searchable marker
`[nc:<business id>]`): carrier-enforced concurrent-call cap equal to the plan
tier, a per-tenant $25/day spend fuse, the full destination whitelist, and the
DID re-pointed onto the tenant app. Idempotent (re-runs adopt by marker).
Whether it has run is in the applied_oneshots ledger.

`provision-truly-insurance-519.ts` (onboarding),
`patch-truly-privyr-first-name.ts`, `patch-truly-classify-call-intent.ts`,
`patch-truly-renewal-reply-fork.ts`, `patch-truly-renewal-wait-order.ts`,
`patch-truly-late-reply-and-source.ts`, `fix-staff-contact-rows.ts`.

## History

PRs #581, #593, #599, #613, #618, #638, #658, #705, #823. The full Privyr flow
has recorded e2e coverage (PR #618), so a change here has a test to run.
Box handoff and cancel-at-period-end lifecycle: PRs #999, #1008, #1011, #1016.
Grace wipe completed 2026-09-08T00:15:05.524Z.
