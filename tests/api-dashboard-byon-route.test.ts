import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

// Keep ByonValidationError real — the route branches on `instanceof`.
vi.mock("@/lib/byon/port-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/byon/port-requests")>();
  return {
    ...actual,
    createByonPortRequest: vi.fn(),
    listByonPortRequests: vi.fn(),
    cancelByonPortRequest: vi.fn()
  };
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 30, remaining: 29, reset: 0 }))
}));

vi.mock("@/lib/byon/tier-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/byon/tier-gate")>();
  return {
    ...actual,
    assertByonAllowedForBusiness: vi.fn()
  };
});

import { DELETE, GET, POST } from "@/app/api/dashboard/byon/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  ByonValidationError,
  cancelByonPortRequest,
  createByonPortRequest,
  listByonPortRequests
} from "@/lib/byon/port-requests";
import { assertByonAllowedForBusiness, BYON_UPGRADE_MESSAGE } from "@/lib/byon/tier-gate";
import { rateLimit } from "@/lib/rate-limit";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";
const REQ_ID = "22222222-2222-4222-8222-222222222222";

function url(qs: string) {
  return `http://localhost/api/dashboard/byon${qs}`;
}

function jsonReq(method: string, qs: string, body?: unknown) {
  return new Request(url(qs), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
}

function validCreateBody() {
  return {
    phone: "+13125550001",
    carrier: { entityName: "Acme LLC", authorizedName: "Jane Doe", accountNumber: "ACC-42" },
    serviceAddress: { street: "311 W Superior St", city: "Chicago", state: "IL", zip: "60654" },
    loa: { base64: "JVBERi0xLjQ=", filename: "loa.pdf" },
    bill: { base64: "JVBERi0xLjQ=", filename: "bill.pdf" }
  };
}

describe("api/dashboard/byon route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
    vi.mocked(rateLimit).mockReturnValue({ success: true } as never);
    vi.mocked(assertByonAllowedForBusiness).mockResolvedValue(undefined);
  });

  it("GET 401 when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(jsonReq("GET", `?businessId=${BIZ}`));
    expect(res.status).toBe(401);
  });

  it("GET 400 on missing businessId", async () => {
    const res = await GET(jsonReq("GET", ""));
    expect(res.status).toBe(400);
  });

  it("GET 429 when rate limited", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false } as never);
    const res = await GET(jsonReq("GET", `?businessId=${BIZ}`));
    expect(res.status).toBe(429);
  });

  it("GET lists requests for the owner", async () => {
    vi.mocked(listByonPortRequests).mockResolvedValue([{ id: REQ_ID } as never]);
    const res = await GET(jsonReq("GET", `?businessId=${BIZ}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.requests).toHaveLength(1);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
    expect(listByonPortRequests).toHaveBeenCalledWith(BIZ);
  });

  it("POST 401 / 429 / 400-zod paths", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null);
    expect((await POST(jsonReq("POST", `?businessId=${BIZ}`, validCreateBody()))).status).toBe(401);

    vi.mocked(rateLimit).mockReturnValueOnce({ success: false } as never);
    expect((await POST(jsonReq("POST", `?businessId=${BIZ}`, validCreateBody()))).status).toBe(429);

    const bad = { ...validCreateBody(), loa: { base64: "", filename: "loa.pdf" } };
    expect((await POST(jsonReq("POST", `?businessId=${BIZ}`, bad))).status).toBe(400);
  });

  it("POST 400 with the upgrade prompt for starter-tier businesses", async () => {
    vi.mocked(assertByonAllowedForBusiness).mockRejectedValueOnce(
      new ByonValidationError(BYON_UPGRADE_MESSAGE)
    );
    const res = await POST(jsonReq("POST", `?businessId=${BIZ}`, validCreateBody()));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toBe(BYON_UPGRADE_MESSAGE);
    expect(createByonPortRequest).not.toHaveBeenCalled();
  });

  it("POST creates the port request and returns 201 (admin bypasses requireBusinessRole)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    vi.mocked(createByonPortRequest).mockResolvedValue({
      rows: [{ id: REQ_ID } as never],
      submitted: true,
      submitError: null
    });
    const res = await POST(jsonReq("POST", `?businessId=${BIZ}`, validCreateBody()));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.submitted).toBe(true);
    expect(requireBusinessRole).not.toHaveBeenCalled();
    expect(createByonPortRequest).toHaveBeenCalledWith(BIZ, expect.objectContaining({
      phone: "+13125550001"
    }));
  });

  it("POST maps ByonValidationError to 400 and other failures to 500", async () => {
    vi.mocked(createByonPortRequest).mockRejectedValueOnce(
      new ByonValidationError("The signed LOA file is too large (max 5 MB).")
    );
    const res = await POST(jsonReq("POST", `?businessId=${BIZ}`, validCreateBody()));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toContain("too large");

    vi.mocked(createByonPortRequest).mockRejectedValueOnce(new Error("telnyx down"));
    expect((await POST(jsonReq("POST", `?businessId=${BIZ}`, validCreateBody()))).status).toBe(500);
  });

  it("DELETE cancels a request", async () => {
    vi.mocked(cancelByonPortRequest).mockResolvedValue({ id: REQ_ID, status: "cancelled" } as never);
    const res = await DELETE(jsonReq("DELETE", `?businessId=${BIZ}&id=${REQ_ID}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.request.status).toBe("cancelled");
    expect(cancelByonPortRequest).toHaveBeenCalledWith(BIZ, REQ_ID);
  });

  it("DELETE 404 when the row is missing, 400 for invalid id / terminal status, 429 when limited", async () => {
    vi.mocked(cancelByonPortRequest).mockResolvedValueOnce(null);
    expect((await DELETE(jsonReq("DELETE", `?businessId=${BIZ}&id=${REQ_ID}`))).status).toBe(404);

    expect((await DELETE(jsonReq("DELETE", `?businessId=${BIZ}&id=nope`))).status).toBe(400);

    vi.mocked(cancelByonPortRequest).mockRejectedValueOnce(
      new ByonValidationError("This number already finished porting — it can't be cancelled.")
    );
    const res = await DELETE(jsonReq("DELETE", `?businessId=${BIZ}&id=${REQ_ID}`));
    expect(res.status).toBe(400);

    vi.mocked(rateLimit).mockReturnValueOnce({ success: false } as never);
    expect((await DELETE(jsonReq("DELETE", `?businessId=${BIZ}&id=${REQ_ID}`))).status).toBe(429);
  });
});
