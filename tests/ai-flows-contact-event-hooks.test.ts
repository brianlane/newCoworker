import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * fireContactEvent: the Node-side wrapper around enqueueContactEventRuns —
 * service client supplied, best-effort throughout. The evaluation mechanics
 * are covered in ai-flows-contact-events.test.ts.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

function makeDb() {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "eq", "or", "limit"]) {
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

describe("fireContactEvent", () => {
  it("supplies the service client and evaluates flows for the business", async () => {
    const { db, calls } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await fireContactEvent(BIZ, {
      kind: "contact_created",
      contact: { e164: "+16025550111" },
      dedupeKey: "ce:test"
    });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    const eq = calls.find((c) => c.name === "eq" && c.args[0] === "business_id");
    expect(eq?.args[1]).toBe(BIZ);
  });

  it("swallows a client-construction failure (best-effort)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await expect(
      fireContactEvent(BIZ, {
        kind: "owner_assigned",
        contact: { e164: "+16025550111" },
        dedupeKey: "ce:test"
      })
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
