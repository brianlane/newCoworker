import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every cron-driven pass-through route must record its run in
 * public.cron_sweep_runs, and must record it under its own name.
 *
 * This is the load-bearing half of the sweep watchdog. The watchdog decides
 * "sweep X never ran tonight" from the ABSENCE of a row, so a sweep that
 * quietly forgets to record is indistinguishable from an outage and would
 * page the operator every single night until someone noticed the wiring was
 * missing. A sweep recording under the wrong name is worse: it invents an
 * outage for one sweep and hides a real one for another.
 *
 * Discovery is mechanical, in the same style as
 * tests/cron-timeout-parity.test.ts, so a cron job added tomorrow is covered
 * the day it lands rather than the day someone remembers to add it here.
 */

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const FUNCTIONS_DIR = join(ROOT, "supabase", "functions");
const ROUTES_DIR = join(ROOT, "src", "app", "api", "internal");

/** Last cron.schedule definition of each job wins, matching apply order. */
function cronJobFunctions(): string[] {
  const byName = new Map<string, string | null>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const block of sql.split(/cron\.schedule\s*\(/).slice(1)) {
      const job = block.match(/^\s*'([^']+)'/)?.[1];
      if (!job) continue;
      const fn = block.match(/\/functions\/v1\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
      byName.set(job, fn ?? byName.get(job) ?? null);
    }
  }
  return [...new Set([...byName.values()].filter((fn): fn is string => fn !== null))];
}

/**
 * A pass-through bridge forwards to exactly one route and bounds it with
 * REQUEST_TIMEOUT_MS: one cron run is one HTTP request, so one row per run
 * is the right granularity. Dispatchers call their routes once per claimed
 * row and are deliberately excluded, since wrapping them would write a row
 * per row of work rather than per sweep.
 */
function passthroughChains(): Array<{ fn: string; route: string }> {
  const chains = new Map<string, string>();
  for (const fn of cronJobFunctions()) {
    const path = join(FUNCTIONS_DIR, fn, "index.ts");
    if (!existsSync(path)) continue;
    const src = readFileSync(path, "utf8");
    const found = [
      ...new Set([...src.matchAll(/\/api\/internal\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]))
    ];
    const hasBudget = /REQUEST_TIMEOUT_MS\s*=\s*[0-9_]+/.test(src);
    if (found.length === 1 && hasBudget) chains.set(fn, found[0]);
  }
  return [...chains.entries()]
    .map(([fn, route]) => ({ fn, route }))
    .sort((a, b) => a.route.localeCompare(b.route));
}

const CHAINS = passthroughChains();
const ROUTES = [...new Set(CHAINS.map((c) => c.route))].sort();

describe("every cron sweep records its run", () => {
  it("discovers the pass-through routes (a broken parser must not pass silently)", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(20);
  });

  for (const route of ROUTES) {
    it(`${route} exports POST through withSweepRun under its own name`, () => {
      const path = join(ROUTES_DIR, route, "route.ts");
      expect(existsSync(path), `missing ${path}`).toBe(true);
      const src = readFileSync(path, "utf8");

      expect(
        src.includes('from "@/lib/cron/sweep-run"'),
        `${route} does not import withSweepRun`
      ).toBe(true);

      // The sweep name is the row's only identity, and the watchdog's
      // expected-sweep list is derived from these same directory names.
      const wired = src.match(/export const POST = withSweepRun\(\s*"([^"]+)"/);
      expect(wired, `${route} does not export POST via withSweepRun`).not.toBeNull();
      expect(wired?.[1], `${route} records under the wrong sweep name`).toBe(route);

      // A leftover bare handler export would bypass the wrapper entirely.
      expect(
        /export\s+(async\s+)?function\s+POST\s*\(/.test(src),
        `${route} still exports a bare POST that skips the wrapper`
      ).toBe(false);
    });
  }
});

/**
 * Every cron bridge must identify itself, because the cron bearer is not
 * exclusive to pg_cron.
 *
 * /api/internal/messenger-worker is kicked fire-and-forget by the Meta
 * webhook on every inbound message, using the same INTERNAL_CRON_SECRET
 * (src/app/api/webhooks/meta/route.ts). Without the header, those rows are
 * indistinguishable from cron runs, so busy Messenger traffic would keep the
 * ledger looking alive while the per-minute cron job was dead, and the
 * watchdog would never report the one sweep whose whole job is being a retry
 * net. The watchdog counts only cron-sourced rows toward liveness.
 *
 * Asserted for every bridge, not just that one: the next route to acquire a
 * second caller should not have to rediscover this.
 */
describe("every cron bridge stamps its runs with its own name", () => {
  for (const { fn, route } of CHAINS) {
    it(`${fn} sends X-Cron-Job on the forward to ${route}`, () => {
      const src = readFileSync(join(FUNCTIONS_DIR, fn, "index.ts"), "utf8");
      const stamped = src.match(/"X-Cron-Job":\s*"([^"]+)"/);
      expect(stamped, `${fn} does not send the X-Cron-Job header`).not.toBeNull();
      expect(stamped?.[1], `${fn} stamps someone else's name`).toBe(fn);
    });
  }
});
