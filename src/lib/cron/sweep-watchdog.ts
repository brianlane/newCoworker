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
  "analytics-snapshot-sweep": { maxGapMinutes: 1500, schedule: "50 2 * * *" },
  "contract-term-nudge-sweep": { maxGapMinutes: 1500, schedule: "25 15 * * *" },
  "cron-sweep-watchdog": { maxGapMinutes: 1500, schedule: "30 3 * * *" },
  "data-retention-sweep": { maxGapMinutes: 1500, schedule: "35 1 * * *" },
  "document-expiration-sweep": { maxGapMinutes: 1500, schedule: "5 2 * * *" },
  "monthly-intro-nudge-sweep": { maxGapMinutes: 1500, schedule: "15 15 * * *" },
  "platform-cost-sync": { maxGapMinutes: 1500, schedule: "10 11 * * *" },
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

export type FindingKind = "missing" | "failed" | "errors" | "degraded" | "slow" | "http";

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
  /** Evaluation time, injected so the decision stays pure. */
  now: number;
};

export type WatchdogResult = {
  findings: Finding[];
  /** Sweeps that reported in and looked fine, for the "all clear" line. */
  healthy: string[];
  checked: number;
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
  const failed: Finding[] = [];
  const withErrors: Finding[] = [];
  const slow: Finding[] = [];
  const healthy: string[] = [];

  const ledgerAgeMinutes =
    input.ledgerOldestAt === null ? 0 : minutesAgo(input.ledgerOldestAt, input.now);

  for (const [sweep, { maxGapMinutes, schedule }] of Object.entries(SWEEP_EXPECTATIONS)) {
    const run = latest.get(sweep);

    if (!run) {
      // Not enough recorded history to distinguish "stopped" from "we only
      // started watching an hour ago".
      if (sweep === WATCHDOG_SWEEP || ledgerAgeMinutes < maxGapMinutes) continue;
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

  const http: Finding[] = input.httpFailures.map((row) => ({
    kind: "http" as const,
    sweep: "(fleet)",
    detail:
      `${row.created}: status ${row.status_code ?? "none"}` +
      `${row.timed_out ? ", TIMED OUT" : ""}` +
      `${row.error_msg ? `, ${row.error_msg}` : ""}`,
    action:
      `net._http_response has no job column, so match it by time against the schedules above. A ` +
      `timed_out row means pg_cron hung up on its own request: compare the job's ` +
      `timeout_milliseconds against the chain's reachable budget. Isolated DNS or peer errors ` +
      `have been transient here before (2026-08-06, 2026-08-07); two in a row is a pattern.`
  }));

  return {
    findings: [...missing, ...failed, ...withErrors, ...degraded, ...slow, ...http],
    healthy: healthy.sort(),
    checked: Object.keys(SWEEP_EXPECTATIONS).length
  };
}
