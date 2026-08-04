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
  /**
   * Every pg_cron job whose body posts to /functions/v1/<name> where a
   * src/app/api/internal/<name>/route.ts exists, plus the one pair whose Edge
   * function forwards to a differently named route (provisioning-watchdog ->
   * provisioning-retry).
   *
   * Deliberately absent: jobs whose Edge function forwards under a different
   * name AND whose cron budget is not 1:1 with a single request, because the
   * bridge fans out per row. Those are edge-ai-flow-worker (-> aiflow-email-poll),
   * edge-customer-memory-summarize-sweep (-> summarize-customer),
   * edge-messenger-jobs-sweep (-> messenger-worker) and edge-sms-inbound-worker
   * (-> owner-sms-turn and contact-booking-context). The last two sit below
   * their route's maxDuration today; whether that is a defect depends on the
   * per-row budget, so it is not asserted here.
   */
  const cases: Array<{ job: string; route: string }> = [
    {
      job: "edge-aiflow-library-refresh",
      route: "src/app/api/internal/aiflow-library-refresh/route.ts"
    },
    {
      job: "edge-analytics-snapshot-sweep",
      route: "src/app/api/internal/analytics-snapshot-sweep/route.ts"
    },
    {
      job: "edge-blog-publish-sweep",
      route: "src/app/api/internal/blog-publish-sweep/route.ts"
    },
    {
      job: "edge-blog-weekly-digest",
      route: "src/app/api/internal/blog-weekly-digest/route.ts"
    },
    {
      job: "edge-contract-term-nudge-sweep",
      route: "src/app/api/internal/contract-term-nudge-sweep/route.ts"
    },
    {
      job: "edge-data-retention-sweep",
      route: "src/app/api/internal/data-retention-sweep/route.ts"
    },
    {
      job: "edge-document-expiration-sweep",
      route: "src/app/api/internal/document-expiration-sweep/route.ts"
    },
    {
      job: "edge-email-campaign-sweep",
      route: "src/app/api/internal/email-campaign-sweep/route.ts"
    },
    {
      job: "edge-meta-capi-drain",
      route: "src/app/api/internal/meta-capi-drain/route.ts"
    },
    {
      job: "edge-monthly-intro-nudge-sweep",
      route: "src/app/api/internal/monthly-intro-nudge-sweep/route.ts"
    },
    {
      job: "edge-outreach-sweep",
      route: "src/app/api/internal/outreach-sweep/route.ts"
    },
    {
      job: "edge-platform-cost-sync",
      route: "src/app/api/internal/platform-cost-sync/route.ts"
    },
    {
      job: "edge-provisioning-watchdog",
      route: "src/app/api/internal/provisioning-retry/route.ts"
    },
    {
      job: "edge-residency-replay",
      route: "src/app/api/internal/residency-replay/route.ts"
    },
    {
      job: "edge-social-post-sweep",
      route: "src/app/api/internal/social-post-sweep/route.ts"
    },
    {
      job: "edge-subscription-grace-sweep",
      route: "src/app/api/internal/subscription-grace-sweep/route.ts"
    },
    {
      job: "edge-tendlc-attach-retry",
      route: "src/app/api/internal/tendlc-attach-retry/route.ts"
    },
    {
      job: "edge-vps-billing-posture",
      route: "src/app/api/internal/vps-billing-posture/route.ts"
    },
    {
      job: "edge-vps-orphan-sweep",
      route: "src/app/api/internal/vps-orphan-sweep/route.ts"
    },
    {
      job: "edge-usage-pack-auto-reload-sweep",
      route: "src/app/api/internal/usage-pack-auto-reload-sweep/route.ts"
    },
    {
      job: "edge-vps-term-renewal-sweep",
      route: "src/app/api/internal/vps-term-renewal-sweep/route.ts"
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
