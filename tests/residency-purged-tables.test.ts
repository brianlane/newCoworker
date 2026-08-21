import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RESIDENCY_CENTRAL_KEPT_TABLES,
  RESIDENCY_CENTRAL_PURGED_TABLES,
  RESIDENCY_MOVED_TABLES,
  RESIDENCY_PURGE_CASCADE_TABLES,
  isResidencyPurgedTable
} from "@/lib/residency/tables";

/**
 * Lockstep between RESIDENCY_CENTRAL_PURGED_TABLES and the SQL that does the
 * actual deleting. The constant is what the read-coverage guard keys off, so
 * a drift here would silently reclassify real debt as "correct centrally",
 * which is the exact mistake the constant was added to prevent.
 *
 * To fix a failure: change BOTH the migration and the constant, or explain
 * the difference by adding to RESIDENCY_PURGE_CASCADE_TABLES. Do not edit
 * only the constant to make this pass.
 */

const ROOT = join(__dirname, "..");
const PURGE_MIGRATION = join(
  ROOT,
  "supabase",
  "migrations",
  "20260707192939_residency_purge.sql"
);

/** Body of residency_purge_business(), so unrelated DDL in the file cannot leak in. */
function purgeFunctionBody(): string {
  const sql = readFileSync(PURGE_MIGRATION, "utf8");
  const start = sql.indexOf("create or replace function public.residency_purge_business");
  expect(start, "residency_purge_business is gone from its migration").toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  expect(end, "could not find the end of residency_purge_business").toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** `delete from public.<name>` targets inside the function body. */
function deletedTables(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/delete\s+from\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    out.add(m[1].toLowerCase());
  }
  return [...out].sort();
}

describe("residency purged-table inventory", () => {
  it("matches the DELETE statements in residency_purge_business()", () => {
    const body = purgeFunctionBody();
    const fromSql = deletedTables(body);

    // Floor: if the matcher breaks, every comparison below goes vacuously
    // green. The function has seven explicit deletes today.
    expect(
      fromSql.length,
      "found no DELETE statements: the extractor broke, it did not pass"
    ).toBeGreaterThanOrEqual(7);

    const expected = RESIDENCY_CENTRAL_PURGED_TABLES.filter(
      (t) => !(RESIDENCY_PURGE_CASCADE_TABLES as readonly string[]).includes(t)
    );
    expect(fromSql).toEqual([...expected].sort());
  });

  it("only ever purges tables that actually move", () => {
    const moved = new Set<string>(RESIDENCY_MOVED_TABLES);
    const strays = RESIDENCY_CENTRAL_PURGED_TABLES.filter((t) => !moved.has(t));
    expect(strays, "a purged table that is not in RESIDENCY_MOVED_TABLES").toEqual([]);
  });

  it("splits every moved table into exactly one of purged or kept", () => {
    expect(
      RESIDENCY_CENTRAL_PURGED_TABLES.length + RESIDENCY_CENTRAL_KEPT_TABLES.length
    ).toBe(RESIDENCY_MOVED_TABLES.length);
    const overlap = RESIDENCY_CENTRAL_KEPT_TABLES.filter((t) => isResidencyPurgedTable(t));
    expect(overlap, "a table cannot be both purged and kept").toEqual([]);
  });

  it("keeps the live engine state the purge migration names as kept", () => {
    // Named explicitly rather than derived: this is the list whose central
    // reads are CORRECT, and the guard inverts its rule for them, so it is
    // worth an assertion a reader can check against the migration comment.
    expect([...RESIDENCY_CENTRAL_KEPT_TABLES].sort()).toEqual(
      [
        "ai_flows",
        "aiflow_url_memory",
        "contacts",
        "dashboard_chat_activity",
        "dashboard_chat_messages",
        "dashboard_chat_threads",
        "sms_rowboat_threads"
      ].sort()
    );
  });

  it("classifies by name", () => {
    expect(isResidencyPurgedTable("email_log")).toBe(true);
    expect(isResidencyPurgedTable("contacts")).toBe(false);
    expect(isResidencyPurgedTable("businesses")).toBe(false);
  });

  it("declares every cascade table as purged", () => {
    for (const t of RESIDENCY_PURGE_CASCADE_TABLES) {
      expect(isResidencyPurgedTable(t)).toBe(true);
    }
  });
});
