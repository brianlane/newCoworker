/**
 * set_contact_reply_mode core (src/lib/customer-tools/reply-mode.ts): the
 * reply-mode write is load-bearing and fails honestly, suppress cancels the
 * lead's pending runs across the identity set (shared cancel core), auto
 * touches nothing else, notes mirror real outcomes, and nothing throws.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  TEXTING_STOPPED_CANCELED_BY,
  setContactTextingMode
} from "@/lib/customer-tools/reply-mode";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+18579289096";
const CANONICAL = "+16025550111";

type Scripted = { data?: unknown; error?: unknown };

/** Chainable fake for the single contact-numbers read (select/eq/or/limit). */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

function deps(db: unknown, overrides: Record<string, unknown> = {}) {
  return {
    createDb: vi.fn(async () => db) as never,
    setReplyMode: vi.fn(async () => undefined) as never,
    // Drain-friendly default: one pass cancels a run, the next finds none.
    cancelRuns: vi
      .fn()
      .mockResolvedValueOnce({ canceledRuns: 1, sweepComplete: true })
      .mockResolvedValue({ canceledRuns: 0, sweepComplete: true }) as never,
    ...overrides
  };
}

describe("setContactTextingMode", () => {
  it("refuses undialable input before touching anything", async () => {
    const d = deps(null);
    for (const bad of ["12345", "not-a-phone x99"]) {
      const res = await setContactTextingMode(BIZ, { phone: bad, mode: "suppress" }, d);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("invalid_phone");
    }
    expect((d.setReplyMode as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((d.cancelRuns as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("fails the whole call honestly when the mode write fails (Error and non-Error)", async () => {
    for (const boom of [new Error("db down"), "string blow-up"]) {
      const d = deps(null, {
        setReplyMode: vi.fn(async () => {
          throw boom;
        }) as never
      });
      const res = await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("reply_mode_failed");
      expect((d.cancelRuns as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    }
  });

  it("suppress: normalizes the number, writes the mode, and cancels runs across the identity set", async () => {
    const { db } = makeDb([
      {
        data: [{ customer_e164: CANONICAL, alias_e164s: ["+15145550123", "junk", 9] }],
        error: null
      }
    ]);
    const d = deps(db);
    const res = await setContactTextingMode(BIZ, { phone: "(857) 928-9096", mode: "suppress" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.phoneE164).toBe(PHONE);
      expect(res.mode).toBe("suppress");
      expect(res.canceledRuns).toBe(1);
      expect(res.runsSweepComplete).toBe(true);
      expect(res.note).toContain("1 pending automation run(s)");
      expect(res.note).toContain("reversible");
    }
    expect(d.setReplyMode).toHaveBeenCalledWith(BIZ, PHONE, "suppress");
    expect(d.cancelRuns).toHaveBeenCalledWith(
      db,
      BIZ,
      [PHONE, CANONICAL, "+15145550123"],
      TEXTING_STOPPED_CANCELED_BY
    );
  });

  it("auto: writes the mode and touches nothing else", async () => {
    const d = deps(null);
    const res = await setContactTextingMode(BIZ, { phone: PHONE, mode: "auto" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mode).toBe("auto");
      expect(res.canceledRuns).toBe(0);
      expect(res.note).toContain("reply to this contact again");
    }
    expect(d.setReplyMode).toHaveBeenCalledWith(BIZ, PHONE, "auto");
    expect((d.createDb as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((d.cancelRuns as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("a contact-lookup error (or null/missing row) continues on the given number alone", async () => {
    const readFail = makeDb([{ data: null, error: { message: "lookup down" } }]);
    const d1 = deps(readFail.db);
    const r1 = await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d1);
    expect(r1.ok).toBe(true);
    expect(d1.cancelRuns).toHaveBeenCalledWith(
      readFail.db,
      BIZ,
      [PHONE],
      TEXTING_STOPPED_CANCELED_BY
    );

    const nullData = makeDb([{ data: null, error: null }]);
    const d2 = deps(nullData.db);
    await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d2);
    expect(d2.cancelRuns).toHaveBeenCalledWith(
      nullData.db,
      BIZ,
      [PHONE],
      TEXTING_STOPPED_CANCELED_BY
    );

    // Contact row with non-string / non-array fields degrades the same way.
    const oddShapes = makeDb([{ data: [{ customer_e164: 7, alias_e164s: "nope" }], error: null }]);
    const d3 = deps(oddShapes.db);
    await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d3);
    expect(d3.cancelRuns).toHaveBeenCalledWith(
      oddShapes.db,
      BIZ,
      [PHONE],
      TEXTING_STOPPED_CANCELED_BY
    );
  });

  it("an incomplete run sweep is reported honestly (mode write still landed)", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    const d = deps(db, {
      cancelRuns: vi.fn(async () => ({ canceledRuns: 0, sweepComplete: false })) as never
    });
    const res = await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.runsSweepComplete).toBe(false);
      expect(res.note).toContain("could not be confirmed as stopped");
    }
  });

  it("drains the 25-run cancel bound across passes, summing the counts", async () => {
    // Suppress has no opt-out backstop, so a single capped call is not
    // enough (Bugbot Medium, PR #898), the core loops until a pass finds
    // nothing.
    const { db } = makeDb([{ data: [], error: null }]);
    const d = deps(db, {
      cancelRuns: vi
        .fn()
        .mockResolvedValueOnce({ canceledRuns: 25, sweepComplete: true })
        .mockResolvedValueOnce({ canceledRuns: 3, sweepComplete: true })
        .mockResolvedValue({ canceledRuns: 0, sweepComplete: true }) as never
    });
    const res = await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.canceledRuns).toBe(28);
      expect(res.runsSweepComplete).toBe(true);
    }
    expect((d.cancelRuns as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("exhausting the drain cap reports an incomplete sweep, never a false all-stopped", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    const d = deps(db, {
      cancelRuns: vi.fn(async () => ({ canceledRuns: 25, sweepComplete: true })) as never
    });
    const res = await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.runsSweepComplete).toBe(false);
      expect(res.canceledRuns).toBe(25 * 8);
      expect(res.note).toContain("could not be confirmed as stopped");
    }
    expect((d.cancelRuns as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8);
  });

  it("a client blow-up after the mode write degrades to the honest partial result (Error and non-Error)", async () => {
    for (const boom of [new Error("no client"), "string blow-up"]) {
      const d = deps(null, {
        createDb: vi.fn(async () => {
          throw boom;
        }) as never
      });
      const res = await setContactTextingMode(BIZ, { phone: PHONE, mode: "suppress" }, d);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.mode).toBe("suppress");
        expect(res.runsSweepComplete).toBe(false);
      }
    }
  });
});
