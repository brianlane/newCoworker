import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A pg_cron job's HTTP timeout must not hang up before the Next route it calls
 * is allowed to finish.
 *
 * #1014 raised several routes to maxDuration = 1800 and rescheduled
 * edge-provisioning-watchdog to match, but left edge-vps-term-renewal-sweep at
 * 800000. pg_cron then disconnected roughly 16 minutes early on every run. The
 * Next function keeps going, so nothing broke, but every sweep was recorded as
 * a timeout in cron.job_run_details, which makes a real timeout invisible.
 */
const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** jobname -> timeout_milliseconds, last definition winning (apply order). */
function effectiveCronTimeouts(): Map<string, number> {
  const out = new Map<string, number>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Each cron.schedule('<name>', '<cron>', $$ ... $$) block, in file order.
    const blocks = sql.split(/cron\.schedule\s*\(/).slice(1);
    for (const block of blocks) {
      const name = block.match(/^\s*'([^']+)'/)?.[1];
      if (!name) continue;
      const timeout = block.match(/timeout_milliseconds\s*:=\s*(\d+)/)?.[1];
      if (timeout) out.set(name, Number(timeout));
    }
  }
  return out;
}

function routeMaxDurationSeconds(relPath: string): number {
  const src = readFileSync(join(process.cwd(), relPath), "utf8");
  const m = src.match(/export const maxDuration\s*=\s*(\d+)/);
  if (!m) throw new Error(`no maxDuration in ${relPath}`);
  return Number(m[1]);
}

describe("edge cron timeouts cover their route budgets", () => {
  const cases: Array<{ job: string; route: string }> = [
    {
      job: "edge-vps-term-renewal-sweep",
      route: "src/app/api/internal/vps-term-renewal-sweep/route.ts"
    },
    {
      job: "edge-provisioning-watchdog",
      route: "src/app/api/internal/provisioning-retry/route.ts"
    },
    {
      job: "edge-vps-orphan-sweep",
      route: "src/app/api/internal/vps-orphan-sweep/route.ts"
    },
    {
      job: "edge-usage-pack-auto-reload-sweep",
      route: "src/app/api/internal/usage-pack-auto-reload-sweep/route.ts"
    }
  ];

  for (const { job, route } of cases) {
    it(`${job} waits at least as long as its route allows`, () => {
      const timeouts = effectiveCronTimeouts();
      const timeoutMs = timeouts.get(job);
      expect(timeoutMs, `no timeout_milliseconds found for ${job}`).toBeDefined();
      expect(timeoutMs as number).toBeGreaterThanOrEqual(
        routeMaxDurationSeconds(route) * 1000
      );
    });
  }
});
