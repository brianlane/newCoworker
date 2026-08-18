import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural guards for the HIPAA audit trail. These assert properties of the
 * SCHEMA and the sweep, not of a function, because that is where this
 * particular guarantee actually lives: a future migration granting UPDATE, or
 * a future sweep adding the table to its list, would quietly destroy the
 * tamper-evidence that makes the log worth having.
 */
describe("phi_access_log is append-only and never swept", () => {
  const MIGRATIONS = join(process.cwd(), "supabase/migrations");

  /** Every migration that mentions the audit table. */
  function migrationsTouchingTable(): string[] {
    return readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => readFileSync(join(MIGRATIONS, f), "utf8").includes("phi_access_log"));
  }

  it("is created by exactly one migration", () => {
    expect(migrationsTouchingTable().length).toBeGreaterThan(0);
  });

  /** SQL with `-- line comments` stripped, so prose about UPDATE is not read as a grant. */
  function withoutComments(sql: string): string {
    return sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
  }

  it("never grants UPDATE or DELETE to any role", () => {
    for (const file of migrationsTouchingTable()) {
      const sql = withoutComments(readFileSync(join(MIGRATIONS, file), "utf8"));
      for (const stmt of sql.split(";")) {
        // Only real GRANT statements. `comment on table ... is '...by grant...'`
        // would otherwise match and fail on its own prose.
        const trimmed = stmt.trim();
        if (!/^grant\b/i.test(trimmed) || !trimmed.includes("phi_access_log")) continue;
        const granted = trimmed.slice(5).split(/\bon\b/i)[0];
        expect(granted.toLowerCase()).not.toMatch(/\bupdate\b/);
        expect(granted.toLowerCase()).not.toMatch(/\bdelete\b/);
        expect(granted.toLowerCase()).not.toMatch(/\ball\b/);
      }
    }
  });

  it("keeps row level security on", () => {
    const sql = migrationsTouchingTable()
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(sql).toMatch(/alter table public\.phi_access_log\s+enable row level security/i);
  });

  it("is not touched by the retention sweep, which would trim the trail", () => {
    const retention = readFileSync(
      join(process.cwd(), "src/lib/privacy/retention.ts"),
      "utf8"
    );
    expect(retention).not.toContain("phi_access_log");
  });

  it("is not touched by end-user erasure either", () => {
    // A patient's erasure request removes their content; the record that
    // someone LOOKED at it is the evidence trail and outlives the content,
    // the same reasoning the acceptance ledger already follows.
    const deletion = readFileSync(
      join(process.cwd(), "src/lib/privacy/deletion.ts"),
      "utf8"
    );
    expect(deletion).not.toContain("phi_access_log");
  });
});
