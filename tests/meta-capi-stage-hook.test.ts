/**
 * Stage-change → Meta CAPI outbox enqueue
 * (supabase/functions/_shared/ai_flows/meta_capi.ts): connection gating,
 * stage-tag matching, dedupe, and the never-throws contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapeLikePattern,
  recordStageChangeForMeta
} from "../supabase/functions/_shared/ai_flows/meta_capi";

const BIZ = "00000000-0000-0000-0000-000000000001";

type Scripted = { data?: unknown; error?: unknown };

/**
 * Scripted db: each terminal (maybeSingle / awaited insert) consumes the
 * next result. Records calls per table for assertions.
 */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "eq", "not", "ilike", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ table, name: "maybeSingle", args: [] });
      return next();
    };
    builder["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const INPUT = {
  contactE164: "+16025551234",
  tag: "Booked",
  dedupeKey: "ce:tag:+16025551234:booked:added:123"
};

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy?.mockRestore();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("escapeLikePattern", () => {
  it("escapes LIKE metacharacters in user tags", () => {
    expect(escapeLikePattern("100% Done_\\x")).toBe("100\\% Done\\_\\\\x");
    expect(escapeLikePattern("Booked")).toBe("Booked");
  });
});

describe("recordStageChangeForMeta", () => {
  it("inserts one outbox row when the connection is CAPI-ready and the tag is a stage", async () => {
    const { db, calls } = makeDb([
      { data: { id: "conn-1" }, error: null }, // meta_connections
      { data: { id: "stage-1" }, error: null }, // pipeline_stages
      { data: null, error: null } // insert
    ]);
    expect(await recordStageChangeForMeta(db, BIZ, INPUT)).toBe(true);
    const insert = calls.find((c) => c.table === "meta_capi_events" && c.name === "insert")!;
    expect(insert.args[0]).toEqual({
      business_id: BIZ,
      contact_e164: "+16025551234",
      event_name: "Booked",
      dedupe_key: INPUT.dedupeKey
    });
    // Stage match is case-insensitive with pattern chars escaped.
    const ilike = calls.find((c) => c.name === "ilike")!;
    expect(ilike.args).toEqual(["name", "Booked"]);
  });

  it("skips (false) without touching stages when no CAPI-ready connection exists", async () => {
    const { db, calls } = makeDb([{ data: null, error: null }]);
    expect(await recordStageChangeForMeta(db, BIZ, INPUT)).toBe(false);
    expect(calls.some((c) => c.table === "pipeline_stages")).toBe(false);
    expect(calls.some((c) => c.name === "insert")).toBe(false);
  });

  it("skips non-stage tags (a 'VIP' tag is not a funnel transition)", async () => {
    const { db, calls } = makeDb([
      { data: { id: "conn-1" }, error: null },
      { data: null, error: null } // no stage row
    ]);
    expect(await recordStageChangeForMeta(db, BIZ, { ...INPUT, tag: "VIP" })).toBe(false);
    expect(calls.some((c) => c.name === "insert")).toBe(false);
  });

  it("skips blank tags and missing contact without any db call", async () => {
    const { db, calls } = makeDb([]);
    expect(await recordStageChangeForMeta(db, BIZ, { ...INPUT, tag: "  " })).toBe(false);
    expect(
      await recordStageChangeForMeta(db, BIZ, { ...INPUT, contactE164: "" })
    ).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("treats a 23505 duplicate insert as already-recorded (no error log)", async () => {
    const { db } = makeDb([
      { data: { id: "conn-1" }, error: null },
      { data: { id: "stage-1" }, error: null },
      { data: null, error: { code: "23505", message: "dup" } }
    ]);
    expect(await recordStageChangeForMeta(db, BIZ, INPUT)).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("logs and returns false on lookup/insert errors — never throws", async () => {
    const connErr = makeDb([{ data: null, error: { message: "conn down" } }]);
    expect(await recordStageChangeForMeta(connErr.db, BIZ, INPUT)).toBe(false);

    const stageErr = makeDb([
      { data: { id: "conn-1" }, error: null },
      { data: null, error: { message: "stage down" } }
    ]);
    expect(await recordStageChangeForMeta(stageErr.db, BIZ, INPUT)).toBe(false);

    const insertErr = makeDb([
      { data: { id: "conn-1" }, error: null },
      { data: { id: "stage-1" }, error: null },
      { data: null, error: { message: "insert down" } }
    ]);
    expect(await recordStageChangeForMeta(insertErr.db, BIZ, INPUT)).toBe(false);

    const thrown = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await recordStageChangeForMeta(thrown, BIZ, INPUT)).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it("bounds the stored dedupe key", async () => {
    const { db, calls } = makeDb([
      { data: { id: "conn-1" }, error: null },
      { data: { id: "stage-1" }, error: null },
      { data: null, error: null }
    ]);
    await recordStageChangeForMeta(db, BIZ, { ...INPUT, dedupeKey: "k".repeat(300) });
    const insert = calls.find((c) => c.name === "insert")!.args[0] as {
      dedupe_key: string;
    };
    expect(insert.dedupe_key.length).toBe(200);
  });
});
