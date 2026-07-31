import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  DEPLOY_CLIENT_DEADLINE_DEFAULT_MS,
  MIGRATION_CUTOVER_RESERVE_MS,
  MIGRATION_DEPLOY_MIN_DEADLINE_MS,
  MIGRATION_ROUTE_BUDGET_MS,
  remainingDeployDeadlineMs
} from "@/lib/provisioning/orchestrate";

/**
 * V7: the 28-minute deploy deadline assumed phase 4 starts at t=0.
 *
 * In a migration it does not: snapshot, SSH tarball backup, purchase, boot and
 * bootstrap all run first, realistically 12 to 18 minutes. A deploy allowed to
 * run the full 28 minutes therefore finished around minute 45, past the 1800s
 * route ceiling, leaving restore, billing repoint and teardown no budget at
 * all. The deadline has to be what is LEFT, not a constant.
 */
describe("remainingDeployDeadlineMs", () => {
  it("never exceeds the standalone default", () => {
    expect(remainingDeployDeadlineMs(0)).toBeLessThanOrEqual(
      DEPLOY_CLIENT_DEADLINE_DEFAULT_MS
    );
  });

  it("shrinks as pre-deploy work eats the budget", () => {
    const fresh = remainingDeployDeadlineMs(0);
    const after10 = remainingDeployDeadlineMs(10 * 60 * 1000);
    const after18 = remainingDeployDeadlineMs(18 * 60 * 1000);
    expect(after10).toBeLessThan(fresh);
    expect(after18).toBeLessThan(after10);
  });

  it("leaves the cutover its reserve while there is room to", () => {
    const elapsed = 10 * 60 * 1000;
    const allowed = remainingDeployDeadlineMs(elapsed);
    expect(elapsed + allowed + MIGRATION_CUTOVER_RESERVE_MS).toBeLessThanOrEqual(
      MIGRATION_ROUTE_BUDGET_MS
    );
  });

  // Deliberate tradeoff: past ~17 minutes the reserve can no longer be honored
  // AND leave a usable deploy window, so the floor wins. Overrunning is safe
  // because the cutover refuses on a failed deploy and leaves the old box
  // running; a 30-second deploy window would just guarantee failure.
  it("prefers a usable deploy window over the reserve when both cannot fit", () => {
    const elapsed = 18 * 60 * 1000;
    const allowed = remainingDeployDeadlineMs(elapsed);
    expect(allowed).toBe(MIGRATION_DEPLOY_MIN_DEADLINE_MS);
    expect(elapsed + allowed + MIGRATION_CUTOVER_RESERVE_MS).toBeGreaterThan(
      MIGRATION_ROUTE_BUDGET_MS
    );
  });

  it("floors at a usable minimum rather than going negative", () => {
    expect(remainingDeployDeadlineMs(29 * 60 * 1000)).toBe(
      MIGRATION_DEPLOY_MIN_DEADLINE_MS
    );
    expect(remainingDeployDeadlineMs(60 * 60 * 1000)).toBe(
      MIGRATION_DEPLOY_MIN_DEADLINE_MS
    );
  });
});

/**
 * V8: #1014 raised the migrate-size route to maxDuration = 1800 (30 min) but
 * left the lease default at 30 minutes, so the lease expired at exactly the
 * moment the route's budget ran out. A second migration could then claim the
 * same business mid-cutover.
 */
describe("vps migration lease", () => {
  it("outlives the migrate-size route budget", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Last definition wins, same as applying them in order.
    let leaseMinutes: number | null = null;
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      if (!sql.includes("function public.try_claim_vps_migration")) continue;
      const match = sql.match(/p_lease_minutes\s+integer\s+default\s+(\d+)/);
      if (match) leaseMinutes = Number(match[1]);
    }
    expect(leaseMinutes).not.toBeNull();

    const route = readFileSync(
      join(process.cwd(), "src", "app", "api", "admin", "vps", "[businessId]", "migrate-size", "route.ts"),
      "utf8"
    );
    const maxDuration = Number(route.match(/maxDuration\s*=\s*(\d+)/)?.[1]);
    expect(Number.isFinite(maxDuration)).toBe(true);

    // Strictly greater: equal means the lease dies exactly when the work does.
    expect((leaseMinutes as number) * 60).toBeGreaterThan(maxDuration);
  });
});
