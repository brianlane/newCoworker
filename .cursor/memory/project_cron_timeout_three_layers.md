---
name: project-cron-timeout-three-layers
description: "Cron timeout parity has three layers, not two; the Edge bridge's REQUEST_TIMEOUT_MS is the one people forget"
metadata: 
  node_type: memory
  type: project
  originSessionId: a849cf80-73f3-4b82-b1be-5e4512ba3010
  modified: 2026-08-20T18:21:43.964Z
---

A scheduled sweep's timeout contract spans three layers, and all three must
cover the one below it:

1. pg_cron `timeout_milliseconds` in the `cron.schedule` body (migration)
2. the Edge function's `REQUEST_TIMEOUT_MS` in `supabase/functions/<name>/index.ts`
3. the Next route's `export const maxDuration` (seconds) in
   `src/app/api/internal/<name>/route.ts`

**OUTDATED as of #1392 (Aug 2026), and this stale line cost a wrong claim to
the user in a later session.** `tests/cron-timeout-parity.test.ts` was a
hand-written list of 4 pairs when this note was written. It now DISCOVERS
every chain from the migrations, Edge functions and routes, reads ALL THREE
layers, and asserts:

    cronMs >= min(routeMs, bridgeMs, EDGE_REQUEST_CEILING_MS /* 150_000 */)

So layer 1 IS guarded, against the smallest ceiling the chain can actually
reach. Do not repeat "the pg_cron layer has no test": read the file.

As of PR #1159 (Aug 3 2026) the bridges are still the early-hangup layer for 13
sweeps: `REQUEST_TIMEOUT_MS = 290_000` on 11 of them, `120_000` on
subscription-grace-sweep and `90_000` on vps-billing-posture, all under their
route's `maxDuration = 300`. PR #1014 is the precedent for doing all three
layers together.

**Why:** raising only the pg_cron timeout stops pg_cron recording a false
timeout in `cron.job_run_details` but does not let the run actually finish, so
the fix can look complete while the chain is still broken.

Two traps that cost four Bugbot rounds on PR #1164, both from reading names and
docstrings instead of tracing where a timeout is applied:

- `callSmsRowboatWithStatelessFallback` takes BOTH `timeoutMs` and `budgetMs`.
  `budgetMs` is documented as the combined wall time, but it only bounds the
  RETRY: the first attempt runs on `timeoutMs` exactly as passed. Clamp both.
- A per-call timeout is not a per-job bound when a failure path falls through
  to another engine. An owner SMS turn (75s) returning null falls through to
  Rowboat (80s), so one job reached ~165s. Add the legs up.

**Copying a schedule file propagates a stale layer-1 value.** PR #1391 added a
new sweep by copying `20260821225221_schedule_vps_term_renewal_sweep.sql`,
which carries `timeout_milliseconds := 800000`. That value had ALREADY been
corrected to 1800000 by `20260822013908_raise_term_renewal_sweep_cron_timeout.sql`,
a separate later file. The copy therefore reintroduced a defect the repo had
already fixed, with a comment falsely claiming parity, and the parity test
could not catch it because it does not guard layer 1 against layer 2. Bugbot
caught it. When starting a new sweep from an existing schedule migration,
grep for LATER migrations that reschedule the same jobname before trusting
the numbers in the file you copied.

Since PR #1560 (Aug 21) the watchdog email is a PAGER: solo HTTP anomalies are
suppressed and counted (summary.suppressedHttp), bursts page (3 in an hour or
5 in the ~6h window), and a sweep with no ledger row at all is graced one
night via the watchdog's own summary.missing memory (fails open; youth-skipped
sweeps count as missing so a pruned ledger cannot grant grace). An email
arriving therefore deserves REAL investigation, not the it-is-probably-noise
triage that was correct before.

**How to apply:** when touching any sweep's timeout, grep all three layers for
that name before deciding the numbers, and trace every fallback path. After a
cron migration merges, verify the LIVE rows with
`tsx debug/read-cron-jobs.ts` (PR #1188, read-only, exit 1 on drift): a green
push-to-main run proves the migration executed, not that cron.job carries the
new numbers. Note edge-residency-replay is deliberately unscheduled live
(20260812000200, zero residency tenants) even though migrations still define
it. That schedules-only-discovery trap has now bitten TWO tools (read-cron-jobs
first draft; the sweep watchdog's fleet test, whose first nightly email was an
ACTION REQUIRED false positive for residency-replay, fixed in PR #1251): any
new tool that derives the cron fleet from migrations MUST replay
cron.unschedule in apply order, not just cron.schedule. Also check the job's cron cadence: a
per-minute job with a deliberately sub-cadence timeout (edge-residency-replay
was 50s) may need `maxDuration` lowered instead of the timeout raised, because
the sweep's lib may take no claim or advisory lock and overlapping runs would
double-apply. See [[project-main-run-watch-trap]].
