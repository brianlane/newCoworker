import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A pg_cron job's HTTP timeout must not hang up before the request it makes
 * can possibly finish, or healthy runs are cut off early and logged as
 * timeouts, and a real timeout becomes impossible to spot.
 *
 * Mechanics note (verified against production, 2026-08-05): pg_net's
 * http_post is ASYNCHRONOUS. The cron run only enqueues the request and
 * finishes in milliseconds, so timeout_milliseconds is enforced by pg_net's
 * background worker and an early hang-up lands as timed_out=true in
 * net._http_response (retained ~6h), NOT in cron.job_run_details as this
 * header used to claim. `tsx debug/cron-http-stats.ts` reads those outcomes.
 *
 * This used to be a hand-written list of job/route pairs, which covered 4 of
 * the 22 chains that existed and silently missed every job added after it.
 * It now discovers the chains by reading the migrations, the Edge functions
 * and the routes, so a new cron job is covered the day it lands.
 *
 * THE CHAIN HAS THREE LAYERS, and each can hang up on the one below it:
 *
 *   pg_cron `timeout_milliseconds`    (supabase/migrations/*.sql)
 *     -> Edge fn `REQUEST_TIMEOUT_MS` (supabase/functions/<fn>/index.ts)
 *       -> route `maxDuration`        (src/app/api/internal/<route>/route.ts)
 *
 * #1014 is the cautionary tale: it raised a route to maxDuration = 1800 and
 * the two layers above it to 1_800_000, but the platform ceiling below still
 * caps that chain at 150s, so the 30-minute budget was never real.
 */

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const FUNCTIONS_DIR = join(ROOT, "supabase", "functions");
const ROUTES_DIR = join(ROOT, "src", "app", "api", "internal");

/**
 * Supabase hangs up on an Edge function that has not responded within 150s
 * and returns 504 to its caller. This is the request idle timeout and it
 * applies on every plan, including Pro: the 400s figure in Supabase's docs is
 * the worker's total wall clock across background tasks, not how long it may
 * take to answer the request that started it.
 * https://supabase.com/docs/guides/functions/limits
 *
 * Every bridge here awaits its route and returns the body, so no chain can
 * outlast this no matter what the numbers above it say.
 */
const EDGE_REQUEST_CEILING_MS = 150_000;

type CronJob = { job: string; fn: string | null; timeoutMs: number | null };

/** Last definition of each job wins, matching migration apply order. */
function discoverCronJobs(): CronJob[] {
  const byName = new Map<string, CronJob>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Each cron.schedule('<name>', '<cron>', $$ ... $$) block, in file order.
    for (const block of sql.split(/cron\.schedule\s*\(/).slice(1)) {
      const job = block.match(/^\s*'([^']+)'/)?.[1];
      if (!job) continue;
      const fn = block.match(/\/functions\/v1\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
      const timeout = block.match(/timeout_milliseconds\s*:=\s*(\d+)/)?.[1];
      const prev = byName.get(job);
      byName.set(job, {
        job,
        fn: fn ?? prev?.fn ?? null,
        timeoutMs: timeout ? Number(timeout) : (prev?.timeoutMs ?? null)
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.job.localeCompare(b.job));
}

type Bridge = { routes: string[]; requestTimeoutMs: number | null };

function readBridge(fn: string): Bridge | null {
  const path = join(FUNCTIONS_DIR, fn, "index.ts");
  if (!existsSync(path)) return null;
  const src = readFileSync(path, "utf8");
  // Matches both the "/api/internal/x" literal and the `${base}/api/internal/x`
  // template form. Order-independent: only the distinct set matters.
  const routes = [
    ...new Set([...src.matchAll(/\/api\/internal\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]))
  ].sort();
  const raw = src.match(/REQUEST_TIMEOUT_MS\s*=\s*([0-9_]+)/)?.[1];
  return { routes, requestTimeoutMs: raw ? Number(raw.replace(/_/g, "")) : null };
}

function routeMaxDurationMs(route: string): number | null {
  const path = join(ROUTES_DIR, route, "route.ts");
  if (!existsSync(path)) return null;
  const m = readFileSync(path, "utf8").match(/export const maxDuration\s*=\s*(\d+)/);
  return m ? Number(m[1]) * 1000 : null;
}

type Chain = {
  job: string;
  fn: string;
  route: string;
  cronMs: number | null;
  bridgeMs: number;
  routeMs: number | null;
};

/**
 * Three shapes of job, and only one of them can be checked for parity:
 *
 * - `passthrough`: forwards to exactly one route and bounds it with
 *   REQUEST_TIMEOUT_MS. One cron run is one HTTP request, so the budgets
 *   compose and the assertion below applies.
 * - `dispatchers`: call routes in a loop, once per claimed row, each with its
 *   own per-call budget. `maxDuration` is the budget of ONE call, not of the
 *   run, so comparing it to the cron timeout would be meaningless. Tracked by
 *   name so a new one cannot quietly appear and skip the parity check.
 * - self-contained: never touches a Next route. Irrelevant here, ignored.
 */
function discoverChains(): { passthrough: Chain[]; dispatchers: string[] } {
  const passthrough: Chain[] = [];
  const dispatchers: string[] = [];
  for (const { job, fn, timeoutMs } of discoverCronJobs()) {
    if (!fn) continue;
    const bridge = readBridge(fn);
    if (!bridge || bridge.routes.length === 0) continue;
    if (bridge.routes.length === 1 && bridge.requestTimeoutMs !== null) {
      const route = bridge.routes[0];
      passthrough.push({
        job,
        fn,
        route,
        cronMs: timeoutMs,
        bridgeMs: bridge.requestTimeoutMs,
        routeMs: routeMaxDurationMs(route)
      });
    } else {
      dispatchers.push(job);
    }
  }
  return { passthrough, dispatchers: dispatchers.sort() };
}

const { passthrough, dispatchers } = discoverChains();

describe("edge cron timeouts cover the budget their chain can actually use", () => {
  it("discovers the pass-through chains (a broken parser must not pass silently)", () => {
    expect(passthrough.length).toBeGreaterThanOrEqual(20);
  });

  for (const chain of passthrough) {
    it(`${chain.job} waits at least as long as its chain can run`, () => {
      expect(chain.cronMs, `no timeout_milliseconds for ${chain.job}`).not.toBeNull();
      expect(
        chain.routeMs,
        `no maxDuration in src/app/api/internal/${chain.route}/route.ts`
      ).not.toBeNull();

      // The request cannot outlast the smallest ceiling in the chain, so that
      // is the only number pg_cron has to cover. Comparing against the route's
      // maxDuration alone would demand 1800000 for a chain the platform cuts
      // off at 150000.
      const reachableMs = Math.min(
        chain.routeMs as number,
        chain.bridgeMs,
        EDGE_REQUEST_CEILING_MS
      );
      expect(chain.cronMs as number).toBeGreaterThanOrEqual(reachableMs);
    });
  }
});

/**
 * Routes that declare more time than their chain can ever hand them. Supabase
 * 504s the bridge at EDGE_REQUEST_CEILING_MS; Vercel keeps running the route
 * to completion in the background, so the work still finishes and the sweeps
 * are unharmed. What is lost is the result: pg_cron records a 504 instead of
 * the route's own outcome.
 *
 * This is recorded rather than fixed: lowering these to 150 would truncate
 * work that completes today, and a daily sweep would leave the remainder for
 * 24 hours. See the README's "The cron chain has three timeouts" section.
 *
 * The assertion is an exact match in both directions, so a new over-declared
 * route has to be added here deliberately, and one that gets fixed has to be
 * removed. Shrinking this list is the goal.
 */
const KNOWN_ABOVE_EDGE_CEILING = [
  // Batch workers with DIRECT callers: the Meta webhook and every team-chat
  // channel's webhook kick these fire-and-forget, and on that path
  // maxDuration genuinely governs. Their budgets are per-turn design (8
  // turns x 30s Gemini / 8 x 60s inline engine), which a quiet week's p95 of
  // ~170ms cannot refute.
  "messenger-worker",
  // One queue for every team-chat channel, so this replaces slack-worker
  // rather than joining it.
  "coworker-worker",
  // Vendor-latency sweeps whose own comments size the budget for slow days
  // (Telnyx MDR paging over a 90-day backfill; ~10 worst-case tenants at 30s
  // each). Background completion past the bridge's 504 is load-bearing here.
  "platform-cost-sync",
  "vps-billing-posture",
  // Backlog-wave budgets from #1014 (1800s): sized for bulk term migrations
  // and provisioning retries, reachable only in exactly the scenario a
  // quiet-week measurement cannot exhibit. Converting these to bounded
  // batches or fire-and-forget bridges is the step-3 design work.
  //
  // vps-contract-upgrade-sweep is the same shape as vps-term-renewal-sweep
  // and shares its migration path (backup, purchase, deploy, restore,
  // cutover), so it inherits the same budget and the same step-3 work. It
  // has no ledger history yet, being new here; clipping it to 150s on the
  // strength of a measurement it has not had would truncate a migration
  // mid-cutover, which is the one failure this whole path is built to avoid.
  "provisioning-retry",
  "vps-term-renewal-sweep",
  "vps-contract-upgrade-sweep"
];

/**
 * Cron jobs whose Edge function calls routes once per claimed row. Their
 * per-call budgets live in the function itself, so parity with the cron
 * timeout is not the right contract for them.
 */
const KNOWN_DISPATCHERS = [
  "edge-ai-flow-worker",
  "edge-customer-memory-summarize-sweep",
  // The digest sweep posts /api/internal/slack-send once per business with
  // a Slack digest leg (PR train: Slack alerts), so its per-call budgets
  // live in the function, not the cron timeout.
  "edge-notifications-digest",
  "edge-notifications-digest-weekly",
  "edge-sms-inbound-worker"
];

describe("the shape of the cron fleet is what the contract above assumes", () => {
  it("only the recorded routes declare more than the Edge ceiling", () => {
    const above = passthrough
      .filter((c) => (c.routeMs ?? 0) > EDGE_REQUEST_CEILING_MS)
      .map((c) => c.route)
      .sort();
    expect([...new Set(above)]).toEqual([...KNOWN_ABOVE_EDGE_CEILING].sort());
  });

  it("only the recorded jobs dispatch per row instead of forwarding once", () => {
    expect(dispatchers).toEqual(KNOWN_DISPATCHERS);
  });
});
