/**
 * Recording a prospect's reply (src/lib/outreach/reply.ts).
 *
 * This closes the loop the follow-up depends on. Without it the nudge is
 * scheduled purely off silence, so a prospect who ALREADY answered gets chased
 * five days later, which reads as a machine talking over them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

const findProspectByEmailSpy = vi.fn();
const patchProspectSpy = vi.fn(async () => true);
vi.mock("@/lib/outreach/db", () => ({
  findProspectByEmail: (...a: unknown[]) => findProspectByEmailSpy(...(a as [])),
  patchProspect: (...a: unknown[]) => patchProspectSpy(...(a as []))
}));

const suppressProspectSpy = vi.fn(async () => {});
vi.mock("@/lib/outreach/suppress", () => ({
  suppressProspect: (...a: unknown[]) => suppressProspectSpy(...(a as []))
}));

import { noteProspectReply } from "@/lib/outreach/reply";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PROSPECT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  patchProspectSpy.mockResolvedValue(true);
});

describe("noteProspectReply", () => {
  it("marks a contacted prospect replied, which is what cancels their follow-up", async () => {
    findProspectByEmailSpy.mockResolvedValue({ id: PROSPECT, status: "sent" });
    expect(
      await noteProspectReply(BIZ, ["info@acmehvac.com"], "Sure, how much is it?", {} as never)
    ).toBe("replied");
    expect(patchProspectSpy).toHaveBeenCalledWith(
      BIZ,
      PROSPECT,
      expect.objectContaining({ status: "replied", replied_at: expect.any(String) }),
      expect.anything()
    );
    expect(suppressProspectSpy).not.toHaveBeenCalled();
  });

  it("finds the prospect when they answer from a DIFFERENT address", async () => {
    // Owners reply from a personal mailbox, or hand the mail to a colleague.
    // Matching only the sender would leave the ledger thinking they never
    // replied, and the silence-based follow-up would chase them anyway.
    findProspectByEmailSpy.mockImplementation(async (_biz: string, email: string) =>
      email === "info@acmehvac.com" ? { id: PROSPECT, status: "sent" } : null
    );
    expect(
      await noteProspectReply(
        BIZ,
        ["owner.personal@gmail.com", "info@acmehvac.com"],
        "Yes, interested",
        {} as never
      )
    ).toBe("replied");
    expect(findProspectByEmailSpy).toHaveBeenCalledTimes(2);
  });

  it("tries each address once, skipping blanks and duplicates", async () => {
    findProspectByEmailSpy.mockResolvedValue(null);
    expect(
      await noteProspectReply(
        BIZ,
        ["  Info@Acme.com ", "info@acme.com", null, undefined, "  "],
        "hi",
        {} as never
      )
    ).toBe("not_a_prospect");
    expect(findProspectByEmailSpy).toHaveBeenCalledTimes(1);
    expect(findProspectByEmailSpy).toHaveBeenCalledWith(BIZ, "info@acme.com", expect.anything());
  });

  it("suppresses somebody who asked to stop, rather than just recording a reply", async () => {
    findProspectByEmailSpy.mockResolvedValue({ id: PROSPECT, status: "sent" });
    expect(
      await noteProspectReply(
        BIZ,
        ["info@acmehvac.com"],
        "Please remove me from your list",
        {} as never
      )
    ).toBe("unsubscribed");
    expect(suppressProspectSpy).toHaveBeenCalledWith(
      BIZ,
      PROSPECT,
      expect.anything(),
      "asked to stop by reply"
    );
    expect(patchProspectSpy).not.toHaveBeenCalled();
  });

  it("ignores mail from anyone who is not a prospect we contacted", async () => {
    findProspectByEmailSpy.mockResolvedValue(null);
    expect(await noteProspectReply(BIZ, ["a.customer@example.com"], "hello", {} as never)).toBe(
      "not_a_prospect"
    );

    // A draft, a skip, or an already-suppressed row is left exactly as it is.
    for (const status of ["drafted", "skipped", "unsubscribed", "replied"]) {
      findProspectByEmailSpy.mockResolvedValue({ id: PROSPECT, status });
      expect(await noteProspectReply(BIZ, ["info@acmehvac.com"], "hi", {} as never)).toBe(
        "already"
      );
    }
    expect(patchProspectSpy).not.toHaveBeenCalled();
  });

  it("honors an opt-out from a row that has already answered us", async () => {
    // The request is about the FUTURE, so what the ledger already thinks of
    // the row is beside the point. Behind the status gate this was reachable
    // only from `sent`, so somebody who wrote back once and then asked to
    // stop was ignored: no ledger stamp, no marketing stamp, and still inside
    // every campaign audience.
    for (const status of ["replied", "drafted", "skipped", "failed"]) {
      suppressProspectSpy.mockClear();
      findProspectByEmailSpy.mockResolvedValue({ id: PROSPECT, status });
      expect(
        await noteProspectReply(BIZ, ["info@acmehvac.com"], "please unsubscribe me", {} as never)
      ).toBe("unsubscribed");
      expect(suppressProspectSpy).toHaveBeenCalledWith(
        BIZ,
        PROSPECT,
        expect.anything(),
        "asked to stop by reply"
      );
    }
  });

  it("does not re-suppress a row that already opted out", async () => {
    suppressProspectSpy.mockClear();
    findProspectByEmailSpy.mockResolvedValue({ id: PROSPECT, status: "unsubscribed" });
    expect(
      await noteProspectReply(BIZ, ["info@acmehvac.com"], "unsubscribe", {} as never)
    ).toBe("already");
    expect(suppressProspectSpy).not.toHaveBeenCalled();
  });

  it("never throws: this is bookkeeping beside the reply, not the reply itself", async () => {
    findProspectByEmailSpy.mockRejectedValue(new Error("ledger down"));
    expect(await noteProspectReply(BIZ, ["info@acmehvac.com"], "hi", {} as never)).toBe(
      "not_a_prospect"
    );

    // A thrown non-Error still gets logged rather than escaping the poll.
    findProspectByEmailSpy.mockRejectedValue("ledger vanished");
    expect(await noteProspectReply(BIZ, ["info@acmehvac.com"], "hi", {} as never)).toBe(
      "not_a_prospect"
    );
  });

  it("works through the default client", async () => {
    findProspectByEmailSpy.mockResolvedValue(null);
    defaultClientSpy.mockReturnValue({});
    expect(await noteProspectReply(BIZ, ["x@y.com"], "hi")).toBe("not_a_prospect");
  });
});
