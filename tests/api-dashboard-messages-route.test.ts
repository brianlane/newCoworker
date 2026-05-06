import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/db/sms-history", () => ({
  listMessagesForCustomer: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 }))
}));

import { GET } from "@/app/api/dashboard/messages/[customerE164]/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { listMessagesForCustomer } from "@/lib/db/sms-history";
import { rateLimit } from "@/lib/rate-limit";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "+15551234567";

function urlFor(customerE164: string, businessId: string | null = BIZ): string {
  const qs = businessId === null ? "" : `?businessId=${encodeURIComponent(businessId)}`;
  return `http://localhost/api/dashboard/messages/${encodeURIComponent(customerE164)}${qs}`;
}

function params(rawSegment: string) {
  return { params: Promise.resolve({ customerE164: rawSegment }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0
  });
});

describe("GET /api/dashboard/messages/:customerE164", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(
      new Request(urlFor(CUSTOMER)),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(401);
  });

  it("rejects a non-E.164 path segment with 400", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    const res = await GET(
      new Request(urlFor("not-a-phone")),
      params("not-a-phone")
    );
    expect(res.status).toBe(400);
  });

  it("validates the businessId query (400 on missing)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    const res = await GET(
      new Request(urlFor(CUSTOMER, null)),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(400);
  });

  it("calls requireOwner for non-admin users", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(listMessagesForCustomer).mockResolvedValue([
      {
        id: "j1:inbound",
        jobId: "j1",
        direction: "inbound",
        content: "hi",
        timestamp: "2026-05-05T00:00:00Z",
        status: "done",
        lastError: null
      }
    ]);

    await GET(new Request(urlFor(CUSTOMER)), params(encodeURIComponent(CUSTOMER)));
    expect(requireOwner).toHaveBeenCalledWith(BIZ);
  });

  it("skips requireOwner for admins", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "admin",
      email: "a@a.com",
      isAdmin: true
    });
    vi.mocked(listMessagesForCustomer).mockResolvedValue([
      {
        id: "j1:inbound",
        jobId: "j1",
        direction: "inbound",
        content: "hi",
        timestamp: "2026-05-05T00:00:00Z",
        status: "done",
        lastError: null
      }
    ]);

    const res = await GET(
      new Request(urlFor(CUSTOMER)),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(requireOwner).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("returns 429 when the rate limiter rejects", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 60_000
    });

    const res = await GET(
      new Request(urlFor(CUSTOMER)),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(429);
  });

  it("returns NOT_FOUND when the thread is empty (sender hasn't texted us)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(listMessagesForCustomer).mockResolvedValue([]);
    const res = await GET(
      new Request(urlFor(CUSTOMER)),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(404);
  });

  it("returns the expanded thread on the happy path", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(listMessagesForCustomer).mockResolvedValue([
      {
        id: "j1:inbound",
        jobId: "j1",
        direction: "inbound",
        content: "hi",
        timestamp: "2026-05-05T00:00:00Z",
        status: "done",
        lastError: null
      },
      {
        id: "j1:outbound",
        jobId: "j1",
        direction: "outbound",
        content: "hello",
        timestamp: "2026-05-05T00:00:01Z",
        status: "done",
        lastError: null
      }
    ]);
    const res = await GET(
      new Request(urlFor(CUSTOMER)),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.customerE164).toBe(CUSTOMER);
    expect(body.data.messages).toHaveLength(2);
    expect(body.data.messages[0].direction).toBe("inbound");
    expect(body.data.messages[1].direction).toBe("outbound");
  });

  it("propagates 500 when the helper throws", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(listMessagesForCustomer).mockRejectedValue(new Error("boom"));
    const res = await GET(
      new Request(urlFor(CUSTOMER)),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(500);
  });

  it("recovers when the path segment is already-decoded (Next removed the %2B)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(listMessagesForCustomer).mockResolvedValue([
      {
        id: "j1:inbound",
        jobId: "j1",
        direction: "inbound",
        content: "hi",
        timestamp: "2026-05-05T00:00:00Z",
        status: "done",
        lastError: null
      }
    ]);
    // The bare `+15551234567` would normally throw on decodeURIComponent
    // (the `+` is decoded to a space); the route catches and falls back.
    const res = await GET(new Request(urlFor(CUSTOMER)), params(CUSTOMER));
    expect(res.status).toBe(200);
  });

  it("400s when the path segment contains a malformed percent-escape", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    // `%E0%A4%A` is a half-encoded UTF-8 byte sequence — decodeURIComponent
    // throws URIError on this. The route should catch it and 400 instead
    // of crashing with a 500.
    const res = await GET(
      new Request(urlFor("%E0%A4%A")),
      params("%E0%A4%A")
    );
    expect(res.status).toBe(400);
  });
});
