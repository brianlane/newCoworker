import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyEditRisk, diffFlowDefinitions } from "@/lib/ai-flows/edit-diff";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * `ai_flow_pending_edits.risk` carries a CHECK constraint listing the risk
 * vocabulary, and `stagePendingEdit` writes whatever `classifyEditRisk`
 * returned straight into it. Those two lists have to agree, and nothing made
 * them: adding "behavioral" to the TypeScript union left the constraint
 * naming only wording / structural / in_flight, so the text surfaces refused
 * such an edit (as intended) while a RICH surface staged it and the INSERT
 * was rejected by the database. The owner would be told the change could not
 * be saved, with no indication why.
 *
 * The unit tests could not catch it: they inject `stageEdit`, so no test in
 * the suite puts a risk value in front of the real column.
 *
 * This reads the constraint out of the migrations the way production builds
 * it (last writer wins) and pins it against the classes the code can actually
 * produce.
 */

const ROOT = join(__dirname, "..");
const MIGRATIONS = join(ROOT, "supabase/migrations");

/** The risk vocabulary as the LAST migration to define it leaves it. */
function riskValuesFromMigrations(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest: string[] | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    // Both the original inline column check and any later ALTER ... ADD
    // CONSTRAINT are written as `check (risk in ('a', 'b'))`.
    for (const m of sql.matchAll(/check\s*\(\s*risk\s+in\s*\(([^)]*)\)\s*\)/gi)) {
      latest = [...m[1].matchAll(/'([^']+)'/g)].map((v) => v[1]);
    }
  }
  if (latest === null) throw new Error("no risk check constraint found in migrations");
  return latest;
}

function def(steps: unknown[]): AiFlowDefinition {
  return { version: 1, trigger: { channel: "manual" }, steps } as unknown as AiFlowDefinition;
}

/**
 * Every class the classifier can hand to `stagePendingEdit`, produced by
 * running the real classifier rather than by restating the union. A class
 * added to the type but unreachable in practice would not need the column;
 * one that is reachable always does.
 */
const REACHABLE_RISKS = (() => {
  const base = def([
    { id: "s1", type: "notify_owner", message: "original" },
    { id: "s2", type: "send_sms", body: "hi" }
  ]);
  const reworded = def([
    { id: "s1", type: "notify_owner", message: "updated" },
    { id: "s2", type: "send_sms", body: "hi" }
  ]);
  const browseBefore = def([
    { id: "b1", type: "browse_action", urlVar: "u", actions: [{ kind: "click_text", target: "A" }] }
  ]);
  const browseAfter = def([
    { id: "b1", type: "browse_action", urlVar: "u", actions: [{ kind: "click_text", target: "B" }] }
  ]);
  const inserted = def([
    { id: "s0", type: "sleep", minutes: 5 },
    { id: "s1", type: "notify_owner", message: "original" },
    { id: "s2", type: "send_sms", body: "hi" }
  ]);
  return new Set([
    classifyEditRisk(diffFlowDefinitions(base, reworded), null),
    classifyEditRisk(diffFlowDefinitions(browseBefore, browseAfter), null),
    classifyEditRisk(diffFlowDefinitions(base, inserted), null),
    classifyEditRisk(diffFlowDefinitions(base, inserted), 0)
  ]);
})();

describe("staged-edit risk vocabulary stays in lockstep with the column", () => {
  it("covers all four classes in the fixtures, so the check below is meaningful", () => {
    // Guards the guard: if a fixture stopped producing its class, the
    // subset assertion would pass vacuously.
    expect([...REACHABLE_RISKS].sort()).toEqual([
      "behavioral",
      "in_flight",
      "structural",
      "wording"
    ]);
  });

  it("the migration allows every class the classifier can stage", () => {
    const allowed = new Set(riskValuesFromMigrations());
    for (const risk of REACHABLE_RISKS) {
      expect(
        allowed.has(risk),
        `classifyEditRisk can return "${risk}" but ai_flow_pending_edits.risk does not allow it, ` +
          `so staging that edit would be rejected by the database. Widen the constraint in a migration.`
      ).toBe(true);
    }
  });

  it("the constraint does not allow a class the code never produces", () => {
    // The other direction: a stale value left in the column's vocabulary is
    // dead policy, and reading it suggests a class that no longer exists.
    // "none" is deliberately absent: pending-edits types the field as
    // Exclude<EditRisk, "none"> because a no-op edit is never staged.
    for (const value of riskValuesFromMigrations()) {
      expect(
        REACHABLE_RISKS.has(value as never),
        `ai_flow_pending_edits.risk allows "${value}" but classifyEditRisk never returns it.`
      ).toBe(true);
    }
  });
});
