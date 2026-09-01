---
name: term-renewal-failures-do-not-self-heal
description: "A failed term-renewal migration is NOT retried by the next run: one migration per run plus a 168h purchase cooldown. Aug 28 + Aug 29 2026 both CHARGED and both reconciled by hand via --adopt-vm; a later green run is not the repair"
metadata:
  node_type: memory
  type: project
  modified: 2026-08-31T14:10:00.000Z
---

**A later successful run of `vps-term-renewal-sweep` does not clear an earlier
failed one.** This was assumed once (2026-08-31) and it is wrong in both
directions: wrong about which tenant, and wrong about the mechanism.

Two things in `src/lib/vps/term-renewal-sweep.ts` make it structural:

1. `runTermRenewalSweep` **`break`s after the first candidate it attempts**, so
   a run performs at most ONE migration. Candidates are sorted by nearest
   `next_billing_at`, so who gets it is a function of the calendar, not of who
   failed yesterday.
2. `DEFAULT_PURCHASE_COOLDOWN_HOURS = 168` (7 days). A tenant that is STILL
   eligible and had a term box bought recently is skipped as
   `skipped_cooldown`, deliberately. The code's own reasoning is the argument:
   still-eligible plus a recent purchase means the earlier purchase never
   finished cutover, so the tenant is on the old box, the PAID new one is
   stranded, and buying again just strands another.

So a failure parks until a human unwinds or finishes it. There is no
self-healing path, and reading a later green run as the repair hides a
stranded paid box.

## The three runs that produced the confusion (all different tenants)

| Run (UTC) | business_id | Outcome |
| --- | --- | --- |
| 2026-08-28 11:00 | `a912aff5` | FAILED `Hostinger purchase returned no virtual_machines (orderId=?)` |
| 2026-08-29 11:00 | `6cc2d7ba` | FAILED `sshExec: connection error: All configured authentication methods failed` |
| 2026-08-30 11:00 | `056034a7` (KYP Ads) | **succeeded**, 552s, bought a term box and cut KYP over |

The Aug 30 success is KYP. It is not a retry of either failure, and both
failures were inside their cooldown that morning.

## Neither failure was a clean abort: both had already CHARGED for a box

The error strings end `old box untouched and still renewing`, which reads like
nothing happened. It is not what happened. Both sit on known fail-but-charge
paths, so both had a paid box behind them:

- `a912aff5` = **KIN Integrated Child Health**, "purchase returned no
  virtual_machines": see [[project_hostinger_purchase_response_shape]]. The
  response is `{ order, virtual_machine }` SINGULAR and we did not parse it, so
  a purchase that SUCCEEDED and was billed reads back as a failure.
- `6cc2d7ba` = **Scar Fairy**, SSH auth rejected: see
  [[project_hostinger_drops_public_key_ids_on_purchase_too]]. The purchase path
  drops `public_key_ids` and lacked the quiescence wait, and an auth rejection
  inside that window means the key is still ARRIVING. The box was bought.

## BOTH ARE RECONCILED (verified 2026-08-31 via debug/audit-fleet-terms.ts)

A human ran `reconcile-migrated-vps-inventory.ts` with an `--adopt-vm`
migration on each, so the already-paid boxes were adopted rather than
abandoned:

| Tenant | New box (adopted) | Hostinger sub | Old box |
| --- | --- | --- | --- |
| KIN (`a912aff5`) | vm 1936826 assigned | `Azyp34VTaWZDIBG8` active, next 2026-09-28 | 1864812 **retired**, sub cancelled |
| Scar Fairy (`6cc2d7ba`) | vm 1939337 assigned | `6okaFVTgN1Ry5TA7` active, next 2026-09-29 | 1867409 **retired**, sub cancelled |
| KYP (`056034a7`) | vm 1941459 assigned (the Aug 30 green run) | `AzqMbsVTmDc649YNQ` active, next 2026-09-30 | pooled by the sweep itself |

So no box was stranded and no old box renewed at full price: the billing-posture
cron retired both lapsed boxes once their subs were cancelled.

**The lesson survives the good outcome, and this is the point.** The repair was
a person running the reconcile one-shot, NOT the next sweep run. An earlier
draft of this memory guessed these were still open, and a later reading guessed
the Aug 30 green run had cleared them; both guesses were wrong in the same way,
by reasoning about the sweep instead of reading `vps_inventory`. The audit is
two minutes: `npx tsx debug/audit-fleet-terms.ts` prints the pool with a `notes`
column that names the script that touched each row.

## The reporting half is fixed, the recovery half is not

Both runs recorded `ok=true, error_count=0` and paged nothing, because the
sweep reported failures in a `findings` array the run recorder does not read.
PR #1755 (merged 2026-08-30 06:03 UTC, so AFTER both) mirrors
`migration_failed` findings into `failures[]`, which the recorder counts. A
future failure pages the same night. That changes nothing about these two.

Related: [[project_cron_timeout_three_layers]] (the pager only counts what the
recorder counts), [[project_watchdog_slow_line_is_per_sweep]] (why the Aug 30
green run's 552s duration is the sweep working, not a fault),
[[project_provision_fail_cancels_sub_keeps_payment]].
