# Scar Fairy

Standard-tier signup from 2026-07-17. Low-touch so far; the operating event
that earned this dossier is the Jul 29 hardware cutover off a mispriced KVM 8
onto Truly's former KVM 2.

## Identity

| | |
| --- | --- |
| Business id | `6cc2d7ba-a007-49d4-93a4-586967e147f1` |
| Tier / box | standard, VPS `1867409` (term-renewal cutover 2026-07-30 from `1815606`, which the Jul 29 cutover had adopted from Truly). Hostinger billing sub `6or6oVQqxWSP17AI`, next billing 2026-08-30 |
| DID | `+13054885455` |
| Owner | Selena Breed |
| Timezone | `America/New_York` (Coral Gables, FL) |
| Website | https://scarfairy.com/ |
| Onboarded | 2026-07-17 |
| Roster | none recorded yet; Selena personally handles all initial inquiries |

Former box: Hostinger vm `1632631` (actual KVM 8 hardware that was mislabeled
`kvm2` in `businesses.vps_size`). Retired 2026-07-29 with `never_renew=true`;
Hostinger sub was already `non_renewing` and lapses **2026-07-30**.

## How leads arrive

Meta lead ads, relayed by the Zapier bridge ("Send Lead to Coworker") to
`POST /api/public/v1/flow-events` with source `facebook_lead_ads`. Bridge-only:
there is no `meta_connections` row, same posture as KYP. The bridge forwards
the Facebook `form_name`, which is what the bundle routing matches on. A switch
to the direct Meta connection would send `form_id` with no title and drop every
lead into the general arm, so revisit the routing if that happens.

## Flows

Read live: `tsx debug/flow-poll.ts 6cc2d7ba-a007-49d4-93a4-586967e147f1`.

| Flow | Trigger | State | Note |
| --- | --- | --- | --- |
| Lead follow-up (white-glove build) | webhook | **off** | Meta lead nurture. Off until Vagaro is connected, see Sharp edges. |

Shape (canonical builder: `scripts/oneshot/scar-fairy-lead-definition.ts`,
applied by `scripts/oneshot/patch-scar-fairy-lead-flow.ts`):

1. Extract, file the contact, notify Selena immediately.
2. `sleep` 3 minutes. This is the self-book window: Meta's thank-you page
   carries the Vagaro link, so a motivated lead books before we ever text.
3. Branch on the lead-form name, one arm per bundle, plus a general arm that
   names all three when the form does not say. Each arm sends one SMS and one
   email quoting that bundle's price.
4. Three gated nudges, then flag Selena and tag the contact Inactive.
5. `s_goal` watching `appointment_booked` and `replied`.

**`s_goal` must stay the last step.** A booking observed during the sleep
fast-forwards the run to the first goal step ahead of it, skipping every send
(`goal_events.ts`, `JUMPABLE_STATUSES` includes `queued`, which covers sleep
deferrals). That skip is the entire "do not text them if they booked"
requirement. Move the goal above the sends and the requirement breaks silently.
`tests/oneshot-scar-fairy-definitions.test.ts` pins the position.

Lead SMS is gated 09:00-20:00 America/New_York per step, rather than by a
flow-level `timeWindow`, so a 2 AM lead still produces an immediate owner
notification while the text waits for morning. Hours are a starting position
and still want Selena's confirmation.

## Sharp edges

- **Vagaro is not connected, and two behaviors depend on it.** There is no
  `vagaro_connections` row (nor Calendly). Without it nothing observes a
  booking, so both the goal jump above AND the automatic pre-send check in
  `src/lib/ai-flows/booking-precheck.ts` are inert, and the flow degrades to
  "always text and email after 3 minutes". That is the KYP booked-then-enrolled
  bug (PR #770) waiting to happen. **Do not enable the flow until Selena has
  connected Vagaro OAuth.**
- **The booking link is still a placeholder.**
  `SCAR_FAIRY_BOOKING_LINK` in `scripts/oneshot/scar-fairy-lead-definition.ts`
  reads `<VAGARO_BOOKING_LINK_PENDING>`, and
  `patch-scar-fairy-lead-flow.ts` refuses `--apply` while it does, so the
  placeholder cannot reach a lead's phone. Landing Selena's real link is a
  one-line diff, a test flip, and a re-run.
- **A pre-booked lead costs Selena the new-lead alert.** `notify_owner` is a
  communication step, so the booking precheck, which runs before a run's first
  comm step, suppresses it along with the sends when the lead already had a
  future booking. Accepted rather than worked around: that lead is visible in
  Vagaro anyway. Revisit if Selena says she is missing leads.
- **Owner-authored config was broken from onboarding and is now repaired.**
  `soul_md` shipped with FAQ questions under "Response Goals", the literal
  placeholder greeting "Hi name.  Thanks for contacting us.", a qualification
  question duplicated mid-sentence, and a handoff rule forbidding any price
  quote that contradicted the flow. `identity_md` was 447 characters listing
  two devices with no concerns, packages, or prices. Both are rewritten by
  `scripts/oneshot/patch-scar-fairy-knowledge.ts` (content in
  `scripts/oneshot/scar-fairy-knowledge-content.ts`). Prices live in
  `identity_md` because identity is a knowledge-graph source at trust 3
  (`src/lib/memory/kg-sources.ts`), the tier a lead's claim cannot supersede.
  That script rewrites `identity_md` whole, so a dashboard edit made between
  runs is overwritten. Read the previous value it prints before re-running.
- **2026-07-29 cutover onto Truly's box.** Order was load-bearing: backup
  Truly → null Truly's Hostinger pointers → fix Scar Fairy's lying
  `vps_size` pin to `kvm8` → `migrate-vps-size --adopt-vm 1815606` → ledger
  1815606 assigned / 1632631 retired. Re-imaging 1815606 destroyed Truly's
  on-box vault; the Storage backup is the reactivation artifact for Truly.
- **Furthest-expiry pool policy** (PR #1008) exists because this cutover
  chose 1815606 (renews Aug 8) over the other pooled KVM 2 that lapses Aug 2.
- **Owner notify on migrate was suppressed** for the overnight window; the
  platform now suppresses owner SMS/email on background migrations generally
  (PR #1011). Do not re-send "Your New Coworker is live!" for a size/term
  migration.
- **2026-07-30 term-renewal cutover, one day after the Jul 29 move, and it
  should not have happened.** The 11:01 UTC sweep bought `1867409` and moved
  Scar Fairy off `1815606`, the box she had just been put on, then pooled
  `1815606` with `never_renew`. Cause: the renewal window was 30 days, but a
  monthly Hostinger box is never more than ~30 days from its next bill, so a
  freshly adopted box re-qualified at once. KYP was hit by the same bug on
  Jul 29 and again on Jul 31. Fixed in two parts: PR #1039 narrowed the window
  (now 36 hours, so the sweep moves a tenant about a day before renewal), and
  the purchase cooldown means a tenant we bought a box for in the last 7 days
  is never bought another. The Jul 29 work stands, it was just undone a day
  later at the cost of a stranded box.
- **Aug 30 check:** Scar Fairy's box (`1867409`, sub `6or6oVQqxWSP17AI`) is
  the one that now renews, at $24.49 as her own. Truly's Stripe period end
  must not touch it. The old Aug 8 date belonged to `1815606`, which she is no
  longer on; that box is pooled `never_renew` and lapses on its own.

## One-shots

**Voice infra (Aug 2026):** `migrate-tenants-to-dedicated-telnyx-apps.ts` moves
this tenant off the shared Telnyx Call Control app/profile onto a DEDICATED
app + outbound voice profile (both named with the searchable marker
`[nc:<business id>]`): carrier-enforced concurrent-call cap equal to the plan
tier, a per-tenant $25/day spend fuse, the full destination whitelist, and the
DID re-pointed onto the tenant app. Idempotent (re-runs adopt by marker).
Whether it has run is in the applied_oneshots ledger.

Pure builders, imported by tests, never executed as scripts:

- `scar-fairy-lead-definition.ts`: the canonical lead-follow-up definition.
- `scar-fairy-knowledge-content.ts`: the canonical `identity.md` and the
  `soul.md` repairs.

Appliers, dry-run by default, `--apply` to write, both ledgered:

- `patch-scar-fairy-lead-flow.ts`: writes the flow definition. Leaves `enabled`
  untouched. Refuses to apply while the booking link is a placeholder.
- `patch-scar-fairy-knowledge.ts`: writes `identity_md` and `soul_md`.

The 2026-07-29 cutover predates these and was run via
`debug/migrate-vps-size.ts` and ad-hoc recovery scripts, not a ledgered file.

## History

Signup / new-signup alert work around PR #710. Cutover and pool policy: PRs
#999, #1008, #1011. Boxless-tenant alert skip (Truly side of the same night):
PR #1016.
