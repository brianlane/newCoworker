import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

const applyLifecycleStage = vi.fn(async (..._args: unknown[]) => "written");
vi.mock("../supabase/functions/_shared/pipelines/lifecycle.ts", () => ({
  applyLifecycleStage: (...args: unknown[]) => applyLifecycleStage(...args)
}));

import { fireLifecycleStage } from "@/lib/pipelines/lifecycle-hooks";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * fireLifecycleStage: the Node-side wrapper around applyLifecycleStage,
 * phone normalization in front, service client supplied, best-effort
 * throughout. The tagging rules themselves live in
 * pipelines-lifecycle-apply.test.ts; this is the plumbing.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const DB = { from: () => ({}) };
const opts = { dedupeSuffix: "booking-1" };

beforeEach(() => {
  applyLifecycleStage.mockClear();
  applyLifecycleStage.mockResolvedValue("written");
  vi.mocked(createSupabaseServiceClient).mockReset();
  vi.mocked(createSupabaseServiceClient).mockResolvedValue(DB as never);
});

describe("fireLifecycleStage", () => {
  it("passes an E.164 number straight through", async () => {
    const out = await fireLifecycleStage(BIZ, "+16026160662", "booked", opts);
    expect(out).toBe("written");
    expect(applyLifecycleStage).toHaveBeenCalledWith(
      DB, BIZ, "+16026160662", "booked", opts
    );
  });

  it("normalizes a loose NANP number", async () => {
    await fireLifecycleStage(BIZ, "(602) 616-0662", "booked", opts);
    expect(applyLifecycleStage.mock.calls[0][2]).toBe("+16026160662");
  });

  it("is a silent no-op on a missing phone", async () => {
    for (const phone of ["", "   ", null, undefined]) {
      expect(await fireLifecycleStage(BIZ, phone, "booked", opts)).toBe("no_contact");
    }
    expect(applyLifecycleStage).not.toHaveBeenCalled();
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("is a silent no-op on an unusable phone", async () => {
    // A missing lead phone is a data gap, not an error.
    expect(await fireLifecycleStage(BIZ, "not a phone", "booked", opts)).toBe("no_contact");
    expect(applyLifecycleStage).not.toHaveBeenCalled();
  });

  it("passes an email contact key through unnormalized", async () => {
    // An email-only lead has no number to normalize, and refusing the key
    // here was why such a lead never reached a board at all.
    await fireLifecycleStage(BIZ, "email:king@kinintegrated.com", "won", opts);
    expect(applyLifecycleStage.mock.calls[0][2]).toBe("email:king@kinintegrated.com");
  });

  it("refuses a malformed email key rather than querying with it", async () => {
    // classifyContactKey validates the address behind the prefix, so this
    // never becomes a lookup that quietly matches nothing.
    expect(await fireLifecycleStage(BIZ, "email:not-an-address", "won", opts)).toBe(
      "no_contact"
    );
    expect(applyLifecycleStage).not.toHaveBeenCalled();
  });

  it("swallows a client-construction failure", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    expect(await fireLifecycleStage(BIZ, "+16026160662", "booked", opts)).toBe("no_change");
  });

  it("returns the applier's own verdict", async () => {
    applyLifecycleStage.mockResolvedValue("no_stage");
    expect(await fireLifecycleStage(BIZ, "+16026160662", "booked", opts)).toBe("no_stage");
  });
});
