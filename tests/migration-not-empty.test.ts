import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Empty-migration guard (.cursor/rules/migration-timestamps.mdc, "Re-stamping: the
 * helper's scaffold is EMPTY").
 *
 * scripts/new-migration.sh creates a zero-byte scaffold. When a stale PR is
 * re-stamped, the SQL has to be moved into the fresh scaffold by hand, and
 * PR #1077 shows what happens when it is not: the restamp commit added only
 * the empty file, a follow-up commit deleted the only copy holding the DDL,
 * and nothing caught it. An empty .sql file passes the stamp guard, the
 * grants test, and `supabase db push`, so main silently never created the
 * column the code depended on (repaired in PR #1091).
 *
 * This test makes that failure a red PR: every migration must contain at
 * least one non-whitespace character.
 *
 * When this fails on your PR, the fix is to put the DDL into the named file
 * (it is probably still in a file you just deleted; check `git show` on the
 * pre-restamp commit), never to add to the allowlist below.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

/**
 * Empty files production's ledger already recorded as applied. The filename
 * must keep existing to match the ledger row (`supabase migration list`
 * shows 20260822024605 applied), so it cannot be deleted or filled in, and
 * as an applied no-op it is harmless. Nothing may ever be added here.
 */
const APPLIED_EMPTY_ALLOWLIST = new Set([
  "20260822024605_booking_shared_calendar_event.sql",
]);

describe("migration files are never empty", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("finds the migrations directory", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    if (APPLIED_EMPTY_ALLOWLIST.has(file)) continue;
    it(`${file} contains SQL`, () => {
      const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      expect(
        /\S/.test(body),
        `${file} is empty or whitespace-only. The re-stamp scaffold from ` +
          `scripts/new-migration.sh starts empty; move the SQL into it and ` +
          `verify with \`wc -c\` before deleting the old copy. See ` +
          `.cursor/rules/migration-timestamps.mdc.`
      ).toBe(true);
    });
  }

  it("the allowlist only names files that still exist", () => {
    for (const file of APPLIED_EMPTY_ALLOWLIST) {
      expect(files).toContain(file);
    }
  });
});
