import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain ESM sidecar source, no types; it ships to the box as-is.
import { compileFilters, SUPPORTED_FILTER_OPS } from "../vps/data-api/filters.mjs";

import { DATA_API_FILTER_OPS } from "@/lib/residency/contract";

/**
 * The data API's filter compiler: the one place a request body becomes SQL.
 *
 * It had no tests at all while it lived inside server.mjs, which exits at
 * import time without DATABASE_URL. Splitting it into filters.mjs is what
 * makes these possible, and the exhaustive value-placement assertions below
 * are the reason the split was worth the Dockerfile risk.
 */

type Compile = (filters: unknown, values: unknown[]) => string;
const compile = compileFilters as Compile;

function run(filters: unknown): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const sql = compile(filters, values);
  return { sql, values };
}

function err(filters: unknown): { code: string; message: string } {
  try {
    run(filters);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected compileFilters to throw");
}

describe("data-api filter grammar", () => {
  it("ANDs plain conditions and parameterizes every value", () => {
    const { sql, values } = run([
      { column: "business_id", op: "eq", value: "biz-1" },
      { column: "direction", op: "eq", value: "inbound" }
    ]);
    expect(sql).toBe(' WHERE "business_id" = $1 AND "direction" = $2');
    expect(values).toEqual(["biz-1", "inbound"]);
  });

  it("compiles IS NULL and, newly, IS NOT NULL", () => {
    expect(run([{ column: "deleted_at", op: "is", value: null }]).sql).toBe(
      ' WHERE "deleted_at" IS NULL'
    );
    // The gap that forced src/lib/db/email-log.ts to fake `.not(col,'is',null)`
    // with a `gte '1970-01-01'` sentinel.
    expect(run([{ column: "archived_at", op: "is", value: null, negate: true }]).sql).toBe(
      ' WHERE "archived_at" IS NOT NULL'
    );
  });

  it("negates other ops the way PostgREST does", () => {
    // NOT (col = v) also excludes NULL rows. Matching PostgREST matters more
    // than being independently defensible: the two paths must agree.
    const { sql, values } = run([{ column: "status", op: "eq", value: "sent", negate: true }]);
    expect(sql).toBe(' WHERE NOT ("status" = $1)');
    expect(values).toEqual(["sent"]);
  });

  it("compiles array containment and overlap against text[]", () => {
    const contains = run([{ column: "labels", op: "contains", value: ["urgent"] }]);
    expect(contains.sql).toBe(' WHERE "labels" @> $1::text[]');
    expect(contains.values).toEqual([["urgent"]]);

    const overlaps = run([{ column: "alias_e164s", op: "overlaps", value: ["+15551234567"] }]);
    expect(overlaps.sql).toBe(' WHERE "alias_e164s" && $1::text[]');
    expect(overlaps.values).toEqual([["+15551234567"]]);
  });

  it("passes the whole array as ONE parameter, never element-wise text", () => {
    // The injection-shaped case: a value that would be dangerous if it were
    // ever interpolated must appear only in `values`.
    const hostile = "'); drop table contacts; --";
    const { sql, values } = run([{ column: "tags", op: "contains", value: [hostile] }]);
    expect(sql).not.toContain("drop table");
    expect(values).toEqual([[hostile]]);
  });

  it("compiles a one-level OR group as ANDed branches ORed together", () => {
    const { sql, values } = run([
      { column: "business_id", op: "eq", value: "biz-1" },
      {
        or: [
          [{ column: "owner_employee_id", op: "eq", value: "emp-1" }],
          [{ column: "owner_employee_id", op: "is", value: null }]
        ]
      }
    ]);
    expect(sql).toBe(
      ' WHERE "business_id" = $1 AND (("owner_employee_id" = $2) OR ("owner_employee_id" IS NULL))'
    );
    expect(values).toEqual(["biz-1", "emp-1"]);
  });

  it("ANDs within a branch and keeps placeholder numbering continuous", () => {
    const { sql, values } = run([
      {
        or: [
          [
            { column: "from_email", op: "ilike", value: "a@b.com" },
            { column: "direction", op: "eq", value: "outbound" }
          ],
          [{ column: "to_email", op: "ilike", value: "a@b.com" }]
        ]
      }
    ]);
    expect(sql).toBe(
      ' WHERE (("from_email" ILIKE $1 AND "direction" = $2) OR ("to_email" ILIKE $3))'
    );
    expect(values).toEqual(["a@b.com", "outbound", "a@b.com"]);
  });

  it("returns an empty clause for no filters, and never a bare WHERE", () => {
    expect(run([]).sql).toBe("");
    expect(run(null).sql).toBe("");
    expect(run(undefined).sql).toBe("");
  });

  describe("refuses rather than guesses", () => {
    it("rejects an unknown op", () => {
      // The property that makes rolling the grammar forward safe: an older
      // box refuses a filter it cannot express instead of silently applying
      // a narrower query and returning wrong rows.
      expect(err([{ column: "a", op: "cs", value: ["x"] }])).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("unknown filter op")
      });
    });

    it("rejects a hostile column name before it reaches quoting", () => {
      expect(err([{ column: 'a"; drop table contacts; --', op: "eq", value: 1 }])).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("invalid filter column")
      });
    });

    it("rejects nested groups", () => {
      expect(
        err([{ or: [[{ or: [[{ column: "a", op: "eq", value: 1 }]] }]] }])
      ).toMatchObject({ message: "'or' groups do not nest" });
    });

    it("rejects empty groups and empty branches", () => {
      expect(err([{ or: [] }]).message).toContain("at least one branch");
      expect(err([{ or: [[]] }]).message).toContain("non-empty array of conditions");
    });

    it("rejects an empty array for in/contains/overlaps", () => {
      for (const op of ["in", "contains", "overlaps"]) {
        expect(err([{ column: "a", op, value: [] }]).message).toContain("non-empty array");
      }
    });

    it("rejects non-string members of an array op", () => {
      expect(err([{ column: "tags", op: "contains", value: [1] }]).message).toContain("text[]");
    });

    it("rejects a non-boolean negate", () => {
      expect(err([{ column: "a", op: "eq", value: 1, negate: "yes" }]).message).toContain(
        "must be a boolean"
      );
    });

    it("still rejects a non-null value for is, and a non-scalar for a scalar op", () => {
      expect(err([{ column: "a", op: "is", value: 1 }]).message).toContain("only supports null");
      expect(err([{ column: "a", op: "eq", value: [1] }]).message).toContain("scalar value");
    });

    it("rejects a filters value that is not an array", () => {
      expect(err({ column: "a" }).message).toBe("filters must be an array");
    });
  });

  it("advertises exactly the ops the platform contract declares", () => {
    // server.mjs has no build step against this repo, so the op list is
    // mirrored rather than imported. A box that advertised fewer ops than the
    // platform sends would fail every read using the missing one.
    expect([...SUPPORTED_FILTER_OPS].sort()).toEqual([...DATA_API_FILTER_OPS].sort());
  });
});
