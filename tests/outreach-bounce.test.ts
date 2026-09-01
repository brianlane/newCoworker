/**
 * Prospecting bounce retirement (src/lib/outreach/bounce.ts): a hard bounce
 * of a cold pitch must take the row off the day-5 nudge queue. The Aug 28
 * one-shot did this after the fact; these tests pin the live path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

const listProspectsByEmailSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const listProspectsByEmailAnyTenantSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const transitionProspectSpy = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@/lib/outreach/db", () => ({
  listProspectsByEmail: (...args: unknown[]) => listProspectsByEmailSpy(...args),
  listProspectsByEmailAnyTenant: (...args: unknown[]) =>
    listProspectsByEmailAnyTenantSpy(...args),
  transitionProspect: (...args: unknown[]) => transitionProspectSpy(...args)
}));

import {
  bounceSubjectMatchesPitch,
  retireProspectsOnBounce
} from "@/lib/outreach/bounce";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PROSPECT = "22222222-2222-4222-8222-222222222222";

function prospect(over: Record<string, unknown> = {}) {
  return {
    id: PROSPECT,
    business_id: BIZ,
    domain: "asapplumbingaz.com",
    business_name: "ASAP Plumbing",
    email: "info@asapplumbingaz.com",
    status: "sent",
    pitch_subject: "ASAP Plumbing: the calls that come in after you close",
    sent_at: "2026-08-26T15:00:00.000Z",
    nudged_at: null,
    replied_at: null,
    ...over
  };
}

const receipt = {
  to: "info@asapplumbingaz.com",
  subject: "ASAP Plumbing: the calls that come in after you close",
  status: "bounced" as const,
  errorCode: "Permanent",
  errorMessage: "hard bounce, no reason given",
  occurredAt: "2026-08-31T08:00:00.000Z",
  businessId: BIZ
};

beforeEach(() => {
  vi.clearAllMocks();
  listProspectsByEmailSpy.mockResolvedValue([]);
  listProspectsByEmailAnyTenantSpy.mockResolvedValue([]);
  transitionProspectSpy.mockResolvedValue(false);
  defaultClientSpy.mockReturnValue({});
});

describe("bounceSubjectMatchesPitch", () => {
  it("matches when either side omitted a subject, and requires equality when both named one", () => {
    expect(bounceSubjectMatchesPitch(null, "A")).toBe(true);
    expect(bounceSubjectMatchesPitch("A", null)).toBe(true);
    expect(bounceSubjectMatchesPitch("A", "A")).toBe(true);
    expect(bounceSubjectMatchesPitch("A", "B")).toBe(false);
  });
});

describe("retireProspectsOnBounce", () => {
  it("moves a sent pitch to failed and keeps sent_at off the patch", async () => {
    listProspectsByEmailSpy.mockResolvedValue([prospect()]);
    transitionProspectSpy.mockResolvedValue(true);

    expect(await retireProspectsOnBounce(receipt)).toBe(1);
    expect(listProspectsByEmailSpy).toHaveBeenCalledWith(
      BIZ,
      "info@asapplumbingaz.com",
      expect.anything()
    );
    expect(listProspectsByEmailAnyTenantSpy).not.toHaveBeenCalled();
    expect(transitionProspectSpy).toHaveBeenCalledWith(
      BIZ,
      PROSPECT,
      "sent",
      {
        status: "failed",
        status_detail:
          "pitch bounced, follow-up cancelled: bounced (Permanent): hard bounce, no reason given"
      },
      expect.anything()
    );
    const patch = transitionProspectSpy.mock.calls[0][3] as {
      sent_at?: unknown;
      status?: string;
      status_detail?: string;
    };
    expect(patch).not.toHaveProperty("sent_at");
  });

  it("ignores a complaint: the mail arrived, and stopping is an owner call", async () => {
    expect(await retireProspectsOnBounce({ ...receipt, status: "complained" })).toBe(0);
    expect(listProspectsByEmailSpy).not.toHaveBeenCalled();
    expect(listProspectsByEmailAnyTenantSpy).not.toHaveBeenCalled();
  });

  it("ignores a blank recipient", async () => {
    expect(await retireProspectsOnBounce({ ...receipt, to: "   " })).toBe(0);
    expect(listProspectsByEmailSpy).not.toHaveBeenCalled();
  });

  it("leaves a row that already replied, already got its nudge, or left sent", async () => {
    listProspectsByEmailSpy.mockResolvedValue([
      prospect({ replied_at: "2026-08-27T00:00:00.000Z" }),
      prospect({ id: "nudge", nudged_at: "2026-08-31T12:00:00.000Z" }),
      prospect({ id: "failed", status: "failed" })
    ]);
    expect(await retireProspectsOnBounce(receipt)).toBe(0);
    expect(transitionProspectSpy).not.toHaveBeenCalled();
  });

  it("does not retire a later pitch when the bounce names a different subject", async () => {
    listProspectsByEmailSpy.mockResolvedValue([prospect()]);
    expect(
      await retireProspectsOnBounce({ ...receipt, subject: "Unrelated owner alert" })
    ).toBe(0);
    expect(transitionProspectSpy).not.toHaveBeenCalled();
  });

  it("does not retire a later pitch using an older bounce of the same address", async () => {
    listProspectsByEmailSpy.mockResolvedValue([prospect()]);
    expect(
      await retireProspectsOnBounce({
        ...receipt,
        occurredAt: "2026-08-20T00:00:00.000Z"
      })
    ).toBe(0);
    expect(transitionProspectSpy).not.toHaveBeenCalled();
  });

  it("still matches a subjectless receipt, the way Resend sometimes arrives", async () => {
    listProspectsByEmailSpy.mockResolvedValue([prospect()]);
    transitionProspectSpy.mockResolvedValue(true);
    expect(await retireProspectsOnBounce({ ...receipt, subject: null })).toBe(1);
  });

  it("retires a failed send the same way as a bounce, even with no extra detail", async () => {
    listProspectsByEmailSpy.mockResolvedValue([prospect({ sent_at: null })]);
    transitionProspectSpy.mockResolvedValue(true);
    expect(
      await retireProspectsOnBounce({
        ...receipt,
        status: "failed",
        errorCode: null,
        errorMessage: null,
        occurredAt: null
      })
    ).toBe(1);
    const patch = transitionProspectSpy.mock.calls[0][3] as { status_detail: string };
    expect(patch.status_detail).toBe("pitch bounced, follow-up cancelled: failed");
  });

  it("formats a code-only bounce and a message-only bounce", async () => {
    listProspectsByEmailSpy.mockResolvedValue([prospect()]);
    transitionProspectSpy.mockResolvedValue(true);
    await retireProspectsOnBounce({ ...receipt, errorMessage: null });
    expect((transitionProspectSpy.mock.calls[0][3] as { status_detail: string }).status_detail).toBe(
      "pitch bounced, follow-up cancelled: bounced (Permanent)"
    );
    await retireProspectsOnBounce({ ...receipt, errorCode: null });
    expect((transitionProspectSpy.mock.calls[1][3] as { status_detail: string }).status_detail).toBe(
      "pitch bounced, follow-up cancelled: bounced: hard bounce, no reason given"
    );
  });

  it("uses an injected client instead of opening a new one", async () => {
    const injected = { tag: "injected" };
    listProspectsByEmailSpy.mockResolvedValue([]);
    await retireProspectsOnBounce(receipt, injected as never);
    expect(defaultClientSpy).not.toHaveBeenCalled();
    expect(listProspectsByEmailSpy).toHaveBeenCalledWith(
      BIZ,
      "info@asapplumbingaz.com",
      injected
    );
  });

  it("counts only rows the guarded transition actually moved", async () => {
    listProspectsByEmailSpy.mockResolvedValue([prospect()]);
    transitionProspectSpy.mockResolvedValue(false);
    expect(await retireProspectsOnBounce(receipt)).toBe(0);
  });

  it("searches every tenant when the receipt has no business id", async () => {
    listProspectsByEmailAnyTenantSpy.mockResolvedValue([prospect()]);
    transitionProspectSpy.mockResolvedValue(true);
    expect(await retireProspectsOnBounce({ ...receipt, businessId: null })).toBe(1);
    expect(listProspectsByEmailAnyTenantSpy).toHaveBeenCalledWith(
      "info@asapplumbingaz.com",
      expect.anything()
    );
    expect(listProspectsByEmailSpy).not.toHaveBeenCalled();
  });

  it("works through the default client", async () => {
    defaultClientSpy.mockReturnValue({ tag: "default" });
    listProspectsByEmailSpy.mockResolvedValue([]);
    expect(await retireProspectsOnBounce(receipt)).toBe(0);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
