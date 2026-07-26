# Truly Insurance

Commercial insurance brokerage. The account that taught us the most about
answer quality: several model and prompt fixes in the platform were found by
reading Truly's transcripts.

## Identity

| | |
| --- | --- |
| Business id | `690f85c0-ee16-4ee5-bde5-5829df2e5410` |
| Tier / box | standard, VPS `1815606` |
| DID | `+15198006401` |
| Owner | Muhammad Fahad |
| Onboarded | 2026-07-08 |
| Roster | Muhammad Fahad, Dania Shaikh, Awais Chauhan |

## How leads arrive

**Privyr sends lead-alert emails to a tenant mailbox**, which is why the main
flow's trigger is `tenant_email` rather than a webhook. Renewals, not new
leads, are the recurring business motion here.

## Flows

| Flow | State | Note |
| --- | --- | --- |
| Lead intake & follow-up (Privyr) (tenant_email, 7) | off | The main flow. HQ keeps a TEST COPY of it as the e2e harness fixture |
| Appointment reminder, 1 hour before (+ broker briefing) (calendar, 3) | off | |
| Appointment reminder, 24 hours before (calendar, 3) | off | |
| Post-appointment follow-up (calendar, 4) | off | |

**All four flows are currently disabled.** Confirm with the owner before
concluding that is a bug; the account has been quiet since late July.

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

## One-shots

`provision-truly-insurance-519.ts` (onboarding),
`patch-truly-privyr-first-name.ts`, `patch-truly-classify-call-intent.ts`,
`patch-truly-renewal-reply-fork.ts`, `patch-truly-renewal-wait-order.ts`,
`patch-truly-late-reply-and-source.ts`, `fix-staff-contact-rows.ts`.

## History

PRs #581, #593, #599, #613, #618, #638, #658, #705, #823. The full Privyr flow
has recorded e2e coverage (PR #618), so a change here has a test to run.
