import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * fireGoalEvent: the Node-side wrapper around applyGoalEvent — phone
 * normalization in front, service client supplied, best-effort throughout.
 * The jump mechanics themselves are covered in ai-flows-goal-events.test.ts;
 * here we verify the wrapper's plumbing.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

/** Minimal fake client: the candidate lookup returns no runs (clean noop). */
function makeDb() {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "upsert", "eq", "or", "in", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fireGoalEvent", () => {
  it("no phone / unusable phone → silent noop, no client created", async () => {
    await fireGoalEvent(BIZ, null, { kind: "appointment_booked" });
    await fireGoalEvent(BIZ, "  ", { kind: "appointment_booked" });
    await fireGoalEvent(BIZ, "not-a-phone", { kind: "appointment_booked" });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("passes an E.164 phone straight through to the run lookup", async () => {
    const { db, calls } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await fireGoalEvent(BIZ, "+16025550111", { kind: "appointment_booked" });
    const orCall = calls.find((c) => c.name === "or");
    expect(String(orCall!.args[0])).toContain("+16025550111");
  });

  it("normalizes a loose NANP number before matching", async () => {
    const { db, calls } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await fireGoalEvent(BIZ, "(602) 555-0111", { kind: "tag_added", tag: "Won" });
    const orCall = calls.find((c) => c.name === "or");
    expect(String(orCall!.args[0])).toContain("+16025550111");
  });

  it("swallows a client-construction failure (best-effort)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await expect(
      fireGoalEvent(BIZ, "+16025550111", { kind: "replied" })
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
