import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 }))
}));
vi.mock("@/lib/leads/claim", () => ({
  claimLeadForCaller: vi.fn()
}));

import { POST } from "@/app/api/dashboard/leads/claim/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { claimLeadForCaller } from "@/lib/leads/claim";

const BIZ = "11111111-1111-4111-8111-111111111111";
const LEAD = "+14805551001";
const DAVE_ID = "22222222-2222-4222-8222-222222222222";

function claimRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/leads/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const USER = { userId: "user-1", email: "dave@biz.test", isAdmin: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(USER as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0
  } as never);
  vi.mocked(claimLeadForCaller).mockResolvedValue({
    outcome: "claimed",
    ownerEmployeeId: DAVE_ID,
    ownerName: "Dave"
  });
});

describe("POST /api/dashboard/leads/claim", () => {
  it("requires authentication", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(res.status).toBe(401);
    expect(claimLeadForCaller).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a contact key", async () => {
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: "not-a-key" }));
    expect(res.status).toBe(400);
    expect(claimLeadForCaller).not.toHaveBeenCalled();
  });

  it("gates on operate_messages for non-admins, and skips the gate for admins", async () => {
    await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");

    vi.mocked(requireBusinessRole).mockClear();
    vi.mocked(getAuthUser).mockResolvedValue({ ...USER, isAdmin: true } as never);
    await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("rate limits writes", async () => {
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0
    } as never);
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(res.status).toBe(429);
    expect(claimLeadForCaller).not.toHaveBeenCalled();
  });

  it("claims and reports the new owner", async () => {
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: {
        claimed: true,
        alreadyMine: false,
        ownerEmployeeId: DAVE_ID,
        ownerName: "Dave"
      }
    });
    expect(claimLeadForCaller).toHaveBeenCalledWith({
      businessId: BIZ,
      contactKey: LEAD,
      callerEmail: "dave@biz.test"
    });
  });

  it("reports an idempotent re-claim as alreadyMine", async () => {
    vi.mocked(claimLeadForCaller).mockResolvedValue({
      outcome: "already_mine",
      ownerEmployeeId: DAVE_ID,
      ownerName: "Dave"
    });
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { alreadyMine: boolean } };
    expect(json.data.alreadyMine).toBe(true);
  });

  it("409s with the current owner's name when somebody else got there first", async () => {
    vi.mocked(claimLeadForCaller).mockResolvedValue({
      outcome: "already_owned",
      ownerName: "Gabby"
    });
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Already claimed by Gabby.",
        ownerName: "Gabby"
      }
    });
  });

  it("409s without a name when the winner's roster row is gone", async () => {
    vi.mocked(claimLeadForCaller).mockResolvedValue({
      outcome: "already_owned",
      ownerName: null
    });
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as {
      error: { message: string; ownerName: string | null };
    };
    expect(json.error.ownerName).toBeNull();
    expect(json.error.message).toBe("Already claimed by another teammate.");
  });

  it("403s an unlinked login and 404s a missing contact", async () => {
    vi.mocked(claimLeadForCaller).mockResolvedValue({ outcome: "not_linked" });
    expect((await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }))).status).toBe(403);

    vi.mocked(claimLeadForCaller).mockResolvedValue({ outcome: "not_found" });
    expect((await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }))).status).toBe(404);
  });

  it("accepts email-keyed and short-code contact keys", async () => {
    for (const key of ["email:dave@example.com", "12345"]) {
      vi.mocked(claimLeadForCaller).mockClear();
      const res = await POST(claimRequest({ businessId: BIZ, contactKey: key }));
      expect(res.status).toBe(200);
      expect(claimLeadForCaller).toHaveBeenCalledWith(
        expect.objectContaining({ contactKey: key })
      );
    }
  });

  it("maps unexpected failures through the shared route error handler", async () => {
    vi.mocked(claimLeadForCaller).mockRejectedValue(new Error("db down"));
    const res = await POST(claimRequest({ businessId: BIZ, contactKey: LEAD }));
    expect(res.status).toBe(500);
  });
});
