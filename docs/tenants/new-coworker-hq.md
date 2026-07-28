# New Coworker (HQ, internal)

Our own tenant. It is simultaneously the dogfood account, the homepage demo
voice line, the site webchat backend, and the default target of every smoke
and e2e script. That overloading is deliberate, and it is the thing to
remember before running anything here.

## Identity

| | |
| --- | --- |
| Business id | `8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d` |
| Tier / box | enterprise, VPS `1806097` (KVM1: 1 vCPU / 4GB) |
| DID | `+16023131823` (also the homepage demo line) |
| Owner | New Coworker Team |
| Onboarded | 2026-07-16 (`scripts/oneshot/onboard-hq-tenant.ts`) |
| Roster | Brian |

There is deliberately **no separate smoke tenant or box**. The old "NCW Flow
Test" tenant and the KVM1 smoke clone were retired when HQ was onboarded. Full
operating detail is in [debug/README.md](../../debug/README.md); this file is
the summary.

## What HQ carries

- **The homepage demo voice line.** A stranger can call `+16023131823` from
  the marketing site and talk to a real Gemini Live session.
- **The newcoworker.com webchat**, re-keyed onto HQ by
  `debug/webchat-rekey.ts`.
- **Contact-form and signup triage**, so our own inbound leads run through our
  own product.
- **The e2e / smoke default.** Anything in `debug/` that writes without an
  explicit business id writes here.
- **Tenant zero for Prospecting.** Our own outbound outreach runs through our
  own product: Places discovery across Phoenix-metro trades, a pitch built
  from what each prospect's site is missing, sent from HQ's connected mailbox.
  Configured by `configure-hq-prospecting.ts` in **manual mode**, so drafts
  wait on a human until the copy earns automatic sending. See the README's
  Prospecting section.

## Flows

| Flow | State | Note |
| --- | --- | --- |
| Demo caller follow-up (contact_created, 6) | on | Follows up with people who call the demo line |
| Webchat lead follow-up (contact_created, 6) | on | |
| Team inbox triage (email, 5) | on | Routine payment receipts deliberately do not page the owner (PR #792) |
| Contact form triage (webhook, 2) | on | Feeds the admin-designated sink business (PR #773) |
| Meta lead follow-up (webhook, 4) | on | |
| Lead intake & follow-up (Privyr) (TEST COPY of Truly) | on | The AiFlow e2e harness fixture, laid down by `debug/flow-test-setup.ts` |
| Google review demo reply (email, 2) | off | Reviewer-facing demo |
| New Contact Greeting (contact_created, 1) | off | |
| Prospect outreach follow-through (webhook, 4) | off | Files and tags the businesses our outbound outreach emails (PR #972). Installed disabled; the pitch itself is sent in code, not by this flow |

## Sharp edges

- **The box is shared hardware.** `srv1806097` also hosts **JobArms**, our
  second product, namespaced end to end. It is the only co-tenanted box in the
  fleet and no customer box may ever join it. Anything that re-images it
  destroys JobArms with no backup of ours to restore:
  `debug/migrate-vps-size.ts` refuses without `--shared-box-ack` and the admin
  panel refuses outright.
- **It is resource-tight by decision.** 4GB and one core, two Chromium
  sidecars, and it answers the demo line over Gemini Live, which is the least
  forgiving neighbor there is. When HQ's voice or chat is slow, read the
  `memory_headroom` posture check before blaming the voice bridge.
- **HQ is long-lived: never bulk-delete its rows.** `flow-test-reset.ts` is
  scoped to the test flow's runs for exactly this reason.
- **Smokes spend HQ's budget and land in HQ's history.** That is the point
  (never a customer's), but it means HQ's usage numbers include our testing.
- **JobArms holds a decrypted copy of this box's SSH key.** The one place a
  credential of ours lives outside this repo, an explicit decision, this
  internal box only. Rotating the keypair means the JobArms deploy needs the
  new one.

## One-shots

`onboard-hq-tenant.ts`, `configure-hq-dogfood.ts`, `setup-hq-dogfood-flows.ts`,
`setup-hq-inbox-triage-flow.ts`, `enable-hq-booking-page.ts`,
`patch-hq-booking-offer.ts`, `set-hq-digest-prefs.ts`,
`configure-hq-prospecting.ts`.

## History

PRs #700 (retarget the smoke/e2e harness defaults here), #776 (HQ dogfood
config and team-inbox triage), #792 (stop owner SMS for routine receipts),
#899 (booking page enabled and linked from the follow-up flows), #921
(guardrails for the co-tenanted box).
