---
name: watchdog-slow-line-is-per-sweep
description: "The cron watchdog's 120s SLOW line is a DEFAULT; seven long-budget sweeps are judged against 80% of their own maxDuration, because a successful migration legitimately runs for minutes"
metadata:
  node_type: memory
  type: project
  modified: 2026-08-31T07:00:00.000Z
---

`SWEEP_SLOW_MS = 120_000` in `src/lib/cron/sweep-watchdog.ts` used to be the
one line every sweep was judged against. It means "you are about to lose the
Edge result", because Supabase 504s a bridge at 150s.

**That warning is empty for the sweeps that lose the Edge result on purpose.**
Seven routes deliberately declare more `maxDuration` than the chain can hand
them (the `KNOWN_ABOVE_EDGE_CEILING` list in
`tests/cron-timeout-parity.test.ts`): Vercel keeps running them in the
background and the work finishes, so the 504 is expected and the sweep's own
`cron_sweep_runs` row still records the outcome.

**The case that proved it (2026-08-30).** `vps-term-renewal-sweep` paged SLOW
for a 552.3s run. The run had SUCCEEDED: it bought a term-priced box and
migrated KYP onto it (`provisioning_jobs`, purpose `term_renewal`, 11:00:40 to
11:09:16), which takes 10 to 30 minutes by nature. Worse, the finding's own
remediation ("shrink the per-run batch, or move to a dispatcher") is
UNFOLLOWABLE for that sweep: it migrates at most one tenant per run by design.
A nightly page nobody can act on is how an alert channel dies.

**Fixed in PR #1759.** `SWEEP_EXPECTATIONS` entries take an optional `slowMs`,
set to 80% of the route's declared `maxDuration` (240s for the four 300s
routes, 1,440s for the three 1800s ones). Past that line the alarm is real and
means something different: Vercel is about to TRUNCATE the run, and a
migration cut off mid-cutover is the exact failure that path exists to avoid.
The finding's action text branches accordingly, so the Edge-ceiling advice
never appears on a sweep it cannot apply to.

Three tests keep it honest, and the pair matters more than either half:

- every `slowMs` must equal 80% of the `maxDuration` its route declares (read
  from the route file, so lowering a budget without revisiting the threshold
  fails the build rather than silently muting the sweep),
- only a route above the Edge ceiling may carry a raised line,
- every route above the ceiling MUST carry one, or it pages on every real run.

**How to apply:** before believing a SLOW finding, ask what the sweep DID.
`cron_sweep_runs.summary` and `provisioning_jobs` answer it. A long run on a
migration sweep is usually the sweep working.

**The Aug 30 green run migrated KYP, and is not the repair for the Aug 28 and
Aug 29 failures.** Those were two other tenants (KIN and Scar Fairy), and both
were reconciled by hand with `reconcile-migrated-vps-inventory.ts --adopt-vm`.
The sweep does one migration per run behind a 168h cooldown, so it never
retries its own failure. See
[[project_term_renewal_failures_do_not_self_heal]].

Related: [[project-cron-timeout-three-layers]] (the three-layer budget and why
layer 1 is guarded against the smallest reachable ceiling).
