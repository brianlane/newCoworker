/**
 * The cron sweep watchdog: decides whether the fleet is healthy, and says
 * what to do about it when it is not.
 *
 * This is the reader half of the ledger written by src/lib/cron/sweep-run.ts.
 * It needs BOTH sources, because neither is sufficient alone:
 *
 *  - public.cron_sweep_runs answers "did it finish, and what went wrong
 *    inside it". A sweep writes its own row, so this is the only place the
 *    silent-200 case (HTTP 200 with a populated errors[] array) is visible.
 *  - net._http_response answers "what happened at the HTTP layer". A sweep
 *    killed by a timeout never reaches the recorder, so its failure exists
 *    only here. Read through the cron_http_failures RPC, since the net
 *    schema is not exposed to PostgREST.
 *
 * Everything in this module is pure. The route does the IO and hands the
 * rows in, so the whole decision surface is testable without a database.
 */

/**
 * How long each sweep may go without finishing before absence means outage.
 *
 * Derived from the live cron schedules with deliberate slack (roughly 3x an
 * every-minute job's period, ~1h on the 5-minute jobs, and just over a full
 * period for the daily and weekly ones) so a single skipped or slow run is
 * not an alert. The point is to catch a sweep that has STOPPED, not one that
 * hiccuped.
 *
 * The key set is asserted against the discovered pass-through fleet in
 * tests/cron-sweep-watchdog.test.ts, so a new cron job cannot land without
 * someone stating its cadence here.
 */
export const SWEEP_EXPECTATIONS: Record<string, { maxGapMinutes: number; schedule: string }> = {
  // Every minute.
  "email-campaign-sweep": { maxGapMinutes: 15, schedule: "* * * * *" },
  "messenger-worker": { maxGapMinutes: 15, schedule: "* * * * *" },
  "meta-capi-drain": { maxGapMinutes: 15, schedule: "* * * * *" },
  "slack-worker": { maxGapMinutes: 15, schedule: "* * * * *" },
  // residency-replay is deliberately absent: 20260812000200 unscheduled the
  // job while zero tenants use residency, so "no run recorded" is its
  // designed state, not an outage. The migration that re-schedules it will
  // trip the exact-match fleet test and force the entry back here.
  "social-post-sweep": { maxGapMinutes: 15, schedule: "* * * * *" },
  "usage-pack-auto-reload-sweep": { maxGapMinutes: 15, schedule: "* * * * * (+ :07,:22,:37,:52)" },
  // Every five minutes.
  "blog-publish-sweep": { maxGapMinutes: 60, schedule: "*/5 * * * *" },
  "outreach-sweep": { maxGapMinutes: 60, schedule: "*/5 * * * *" },
  "provisioning-retry": { maxGapMinutes: 60, schedule: "*/5 * * * *" },
  "tendlc-attach-retry": { maxGapMinutes: 60, schedule: "*/5 * * * *" },
  // Hourly.
  "aiflow-library-refresh": { maxGapMinutes: 150, schedule: "7 * * * *" },
  // Daily.
  "abandoned-signup-sweep": { maxGapMinutes: 1500, schedule: "40 4 * * *" },
  "analytics-snapshot-sweep": { maxGapMinutes: 1500, schedule: "50 2 * * *" },
  "contract-term-nudge-sweep": { maxGapMinutes: 1500, schedule: "25 15 * * *" },
  "cron-sweep-watchdog": { maxGapMinutes: 1500, schedule: "30 3 * * *" },
  "data-retention-sweep": { maxGapMinutes: 1500, schedule: "35 1 * * *" },
  "document-expiration-sweep": { maxGapMinutes: 1500, schedule: "5 2 * * *" },
  "monthly-intro-nudge-sweep": { maxGapMinutes: 1500, schedule: "15 15 * * *" },
  "priority-support-nudge-sweep": { maxGapMinutes: 1500, schedule: "35 15 * * *" },
  "platform-cost-sync": { maxGapMinutes: 1500, schedule: "10 11 * * *" },
  "segment-action-sweep": { maxGapMinutes: 1500, schedule: "10 9 * * *" },
  "subscription-grace-sweep": { maxGapMinutes: 1500, schedule: "15 0 * * *" },
  "vps-billing-posture": { maxGapMinutes: 1500, schedule: "0 13 * * *" },
  "vps-contract-upgrade-sweep": { maxGapMinutes: 1500, schedule: "30 10 * * *" },
  "vps-orphan-sweep": { maxGapMinutes: 1500, schedule: "0 12 * * *" },
  "vps-term-renewal-sweep": { maxGapMinutes: 1500, schedule: "0 11 * * *" },
  // Weekly (Mondays).
  "blog-weekly-digest": { maxGapMinutes: 10_200, schedule: "0 15 * * 1" }
};

/**
 * Supabase 504s an Edge function that has not answered in 150s, and every
 * cron bridge awaits its route, so no chain can outlast this. Alerting at
 * 120s means the operator hears about a sweep APPROACHING the ceiling
 * rather than after it starts losing its result.
 *
 * Measured headroom on 2026-08-08: analytics-snapshot-sweep, the only one of
 * the overnight four whose cost scales with tenant count, took 2,853ms for 8
 * businesses (~356ms each). Linear scaling puts it at this threshold around
 * 335 businesses and at the hard ceiling around 420.
 */
export const SWEEP_SLOW_MS = 120_000;
export const EDGE_REQUEST_CEILING_MS = 150_000;

/**
 * The watchdog does not report ITSELF as missing. It obviously ran: it is the
 * thing doing the reporting. Its own row is still written and still checked
 * for failure and duration, but absence is a claim only something outside it
 * could make.
 */
export const WATCHDOG_SWEEP = "cron-sweep-watchdog";

export type SweepRunRow = {
  sweep: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  error_count: number;
  errors: string[];
};

export type HttpFailureRow = {
  id: number;
  status_code: number | null;
  timed_out: boolean | null;
  error_msg: string | null;
  created: string;
};

export type FindingKind = "missing" | "failed" | "errors" | "degraded" | "slow" | "burst" | "http";

/**
 * The pager contract for the HTTP layer. Six solo anomalies between Aug 6
 * and Aug 20 were each verified harmless by hand: every real victim already
 * pages through the ledger (a crashed run as "failed", a stopped schedule as
 * "missing" once its gap passes), so a lone timeout or transport error is
 * counted and suppressed. A BURST pages: three anomalies inside one hour, or
 * five anywhere in the ~6h retention window, is the "two in a row is a
 * pattern" prose finally enforced with numbers, and catches infra decay that
 * has not yet cost a recorded run.
 */
export const HTTP_BURST_WINDOW_MS = 3_600_000;
export const HTTP_BURST_IN_WINDOW = 3;
export const HTTP_BURST_TOTAL = 5;

export type Finding = {
  kind: FindingKind;
  /** Sweep name, or "(fleet)" for HTTP-layer failures that carry no job. */
  sweep: string;
  /** One-line statement of what is wrong. */
  detail: string;
  /** What the operator should actually do about it. */
  action: string;
};

export type WatchdogInput = {
  /** Every cron_sweep_runs row in the lookback window. */
  runs: SweepRunRow[];
  /** net._http_response failures from the RPC. */
  httpFailures: HttpFailureRow[];
  /**
   * Set when the cron_http_failures RPC could not be read, which leaves this
   * run blind to the entire timeout class.
   *
   * Reported as its own finding rather than folded into the run's errors[]:
   * the recorder reads errors[] as per-tenant work failures, so encoding an
   * infrastructure problem there would make the NEXT run classify it as a
   * silent-200 and print per-tenant remediation for a missing grant.
   */
  httpReadError: string | null;
  /**
   * Oldest finished_at anywhere in cron_sweep_runs. A sweep can only be
   * called missing once we have been recording for longer than its own
   * max gap, otherwise every sweep looks missing on the day this ships and
   * again after any prune that empties the table.
   */
  ledgerOldestAt: string | null;
  /**
   * The sweeps YESTERDAY's watchdog run saw as missing (its own summary row
   * carries them), or null when yesterday cannot be read. Enables the
   * new-sweep first-night grace: a sweep with no row at all is logged rather
   * than paged the first night, and pages the second. Null FAILS OPEN to "no
   * grace": muting a sweep whose recording never worked is the worse error.
   */
  previouslyMissing: string[] | null;
  /** Evaluation time, injected so the decision stays pure. */
  now: number;
};

export type WatchdogResult = {
  findings: Finding[];
  /** Sweeps that reported in and looked fine, for the "all clear" line. */
  healthy: string[];
  checked: number;
  /** First-night absentees, logged rather than paged. */
  graced: string[];
  /** Lone HTTP anomalies counted but below the burst bar. */
  suppressedHttp: number;
  /**
   * Every sweep this run saw as missing, paged AND graced, for the run's own
   * summary row: tomorrow's watchdog reads it back as previouslyMissing.
   */
  missingSweeps: string[];
};

function minutesAgo(iso: string, now: number): number {
  return (now - Date.parse(iso)) / 60_000;
}

/** Latest run per sweep, by finished_at. */
export function latestRuns(runs: SweepRunRow[]): Map<string, SweepRunRow> {
  const out = new Map<string, SweepRunRow>();
  for (const run of runs) {
    const prev = out.get(run.sweep);
    if (!prev || Date.parse(run.finished_at) > Date.parse(prev.finished_at)) {
      out.set(run.sweep, run);
    }
  }
  return out;
}

/**
 * Decide the health of the fleet.
 *
 * Findings are ordered by how badly the operator needs them: a sweep that
 * stopped entirely, then one that crashed, then one failing per tenant, then
 * one drifting toward the timeout ceiling, then raw HTTP failures.
 */
export function evaluateSweepHealth(input: WatchdogInput): WatchdogResult {
  const latest = latestRuns(input.runs);
  const missing: Finding[] = [];
  const graced: string[] = [];
  const missingSweeps: string[] = [];
  const failed: Finding[] = [];
  const withErrors: Finding[] = [];
  const slow: Finding[] = [];
  const healthy: string[] = [];

  const ledgerAgeMinutes =
    input.ledgerOldestAt === null ? 0 : minutesAgo(input.ledgerOldestAt, input.now);

  for (const [sweep, { maxGapMinutes, schedule }] of Object.entries(SWEEP_EXPECTATIONS)) {
    const run = latest.get(sweep);

    if (!run) {
      if (sweep === WATCHDOG_SWEEP) continue;
      // Not enough recorded history to distinguish "stopped" from "we only
      // started watching an hour ago". Still remembered as missing: a night
      // that never evaluated a sweep must not hand tomorrow positive-looking
      // evidence it was fine, or the night after a ledger prune would grace
      // (mute) a sweep that has been dead all along.
      if (ledgerAgeMinutes < maxGapMinutes) {
        missingSweeps.push(sweep);
        continue;
      }
      // First-night grace for a sweep with no row at all: a new daily sweep
      // merged after its UTC slot cannot have run yet. Grace requires
      // POSITIVE evidence it was not missing yesterday; an unreadable
      // yesterday gives no grace.
      if (input.previouslyMissing !== null && !input.previouslyMissing.includes(sweep)) {
        graced.push(sweep);
        missingSweeps.push(sweep);
        continue;
      }
      missingSweeps.push(sweep);
      missing.push({
        kind: "missing",
        sweep,
        detail: `no run recorded in the last ${maxGapMinutes} minutes (schedule ${schedule})`,
        action:
          `Check the live cron row first: \`tsx debug/read-cron-jobs.ts\` reports an INACTIVE or ` +
          `missing job as drift. If the job is live, the chain is failing before the route: read ` +
          `\`tsx debug/cron-http-stats.ts\` within 6h of the missed run for the HTTP-layer reason.`
      });
      continue;
    }

    const age = minutesAgo(run.finished_at, input.now);
    if (age > maxGapMinutes && sweep !== WATCHDOG_SWEEP) {
      missingSweeps.push(sweep);
      missing.push({
        kind: "missing",
        sweep,
        detail: `last finished ${Math.round(age)} minutes ago, expected every ${maxGapMinutes} (schedule ${schedule})`,
        action:
          `The sweep ran before and has stopped. \`tsx debug/read-cron-jobs.ts\` for the live job ` +
          `row, then \`tsx debug/cron-http-stats.ts\` for what the last attempts did.`
      });
      continue;
    }

    let flagged = false;
    if (!run.ok) {
      flagged = true;
      failed.push({
        kind: "failed",
        sweep,
        detail: `last run threw: ${run.errors[0] ?? "no error recorded"}`,
        action:
          `The sweep crashed rather than completing. Read the Vercel logs for ` +
          `/api/internal/${sweep} around ${run.finished_at}; the row's errors column carries the ` +
          `thrown message.`
      });
    } else if (run.error_count > 0) {
      flagged = true;
      withErrors.push({
        kind: "errors",
        sweep,
        detail: `last run answered ok but reported ${run.error_count} error(s): ${run.errors.slice(0, 3).join("; ")}`,
        action:
          `This is the silent-200 case: the sweep completed and part of its work failed, so no ` +
          `HTTP-layer tool will show it. The errors are usually per tenant. Fix the underlying ` +
          `cause; the next run converges since every sweep here is idempotent.`
      });
    }

    if (run.duration_ms > SWEEP_SLOW_MS) {
      flagged = true;
      slow.push({
        kind: "slow",
        sweep,
        detail: `last run took ${(run.duration_ms / 1000).toFixed(1)}s, past the ${SWEEP_SLOW_MS / 1000}s warning line`,
        action:
          `Supabase 504s the Edge bridge at ${EDGE_REQUEST_CEILING_MS / 1000}s and the result is ` +
          `lost (the work still finishes on Vercel). Either shrink the per-run batch or move the ` +
          `sweep to a dispatcher that claims rows, as the ai-flow and sms-inbound workers do.`
      });
    }

    if (!flagged) healthy.push(sweep);
  }

  const degraded: Finding[] =
    input.httpReadError === null
      ? []
      : [
          {
            kind: "degraded" as const,
            sweep: WATCHDOG_SWEEP,
            detail: `could not read net._http_response: ${input.httpReadError}`,
            action:
              `This run checked the sweep ledger but NOT the HTTP layer, so timeouts and transport ` +
              `errors went unexamined. The reader is the cron_http_failures(integer) RPC: confirm its ` +
              `migration applied and that service_role still has EXECUTE on it. Everything else in ` +
              `this email is still accurate, just incomplete.`
          }
        ];

  // HTTP anomalies page only as a burst; see HTTP_BURST_* above.
  const anomalyLine = (row: HttpFailureRow) =>
    `${row.created}: status ${row.status_code ?? "none"}` +
    `${row.timed_out ? ", TIMED OUT" : ""}` +
    `${row.error_msg ? `, ${row.error_msg}` : ""}`;
  const times = input.httpFailures
    .map((row) => Date.parse(row.created))
    .sort((a, b) => a - b);
  const denseHour = times.some(
    (t, i) =>
      i + HTTP_BURST_IN_WINDOW - 1 < times.length &&
      times[i + HTTP_BURST_IN_WINDOW - 1] - t <= HTTP_BURST_WINDOW_MS
  );
  const isBurst = input.httpFailures.length >= HTTP_BURST_TOTAL || denseHour;
  const burst: Finding[] = isBurst
    ? [
        {
          kind: "burst" as const,
          sweep: "(fleet)",
          detail:
            `${input.httpFailures.length} anomalies in the HTTP window, past the ` +
            `${HTTP_BURST_IN_WINDOW}-per-hour / ${HTTP_BURST_TOTAL}-per-window pager bar:\n` +
            input.httpFailures.map((row) => `      ${anomalyLine(row)}`).join("\n"),
          action:
            `No recorded sweep has failed yet (that would page on its own), so this is infra ` +
            `degradation in the pg_net worker or the network path: DNS hangs and instant bridge ` +
            `failures clustering instead of arriving as the usual isolated one-offs. Read ` +
            `\`tsx debug/cron-http-stats.ts\` while the rows are inside the ~6h retention, and if ` +
            `the cluster is DNS, raise it with Supabase; nothing in this repo resolves names.`
        }
      ]
    : [];
  const suppressedHttp = isBurst ? 0 : input.httpFailures.length;

  return {
    findings: [...missing, ...failed, ...withErrors, ...degraded, ...slow, ...burst],
    healthy: healthy.sort(),
    checked: Object.keys(SWEEP_EXPECTATIONS).length,
    graced: graced.sort(),
    suppressedHttp,
    missingSweeps: missingSweeps.sort()
  };
}
