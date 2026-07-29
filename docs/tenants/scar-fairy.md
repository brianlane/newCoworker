# Scar Fairy

Standard-tier signup from 2026-07-17. Low-touch so far; the operating event
that earned this dossier is the Jul 29 hardware cutover off a mispriced KVM 8
onto Truly's former KVM 2.

## Identity

| | |
| --- | --- |
| Business id | `6cc2d7ba-a007-49d4-93a4-586967e147f1` |
| Tier / box | standard, VPS `1815606` (KVM 2). Adopted 2026-07-29 from Truly; Hostinger billing sub `AzywqVVOpCob62ZiY`, auto-renew ON, next billing ~2026-08-08 |
| DID | `+13054885455` |
| Owner | Confirm in admin (owner SMS went to the signup phone; business DID is above) |
| Onboarded | 2026-07-17 |
| Roster | none recorded yet |

Former box: Hostinger vm `1632631` (actual KVM 8 hardware that was mislabeled
`kvm2` in `businesses.vps_size`). Retired 2026-07-29 with `never_renew=true`;
Hostinger sub was already `non_renewing` and lapses **2026-07-30**.

## How leads arrive

Still early. One starter / library flow may exist; treat live flow state as
source of truth rather than this file until the account grows real traffic.

## Flows

Read live: `tsx debug/flow-poll.ts 6cc2d7ba-a007-49d4-93a4-586967e147f1`.
Context-pack snapshot at cutover time was 0 enabled / 1 total.

## Sharp edges

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
- **Jul 30 check:** confirm 1632631 is gone on Hostinger and Scar Fairy is
  still healthy on 1815606. **Aug 8 check:** Scar Fairy's box renews at
  $24.49 as her own; Truly's Stripe period end must not touch this VM.

## One-shots

None tenant-named yet. Cutover was run via `debug/migrate-vps-size.ts` and
ad-hoc recovery scripts, not a ledgered `scripts/oneshot/` file.

## History

Signup / new-signup alert work around PR #710. Cutover and pool policy: PRs
#999, #1008, #1011. Boxless-tenant alert skip (Truly side of the same night):
PR #1016.
