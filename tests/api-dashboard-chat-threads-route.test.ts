import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/dashboard-chat", () => ({
  listThreadsForBusiness: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { GET } from "@/app/api/dashboard/chat/threads/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { listThreadsForBusiness } from "@/lib/db/dashboard-chat";

const BIZ = "11111111-1111-4111-8111-111111111111";

function urlFor(businessId: string | null): Request {
  const qs = businessId === null ? "" : `?businessId=${encodeURIComponent(businessId)}`;
  return new Request(`http://localhost/api/dashboard/chat/threads${qs}`);
}

const SUMMARY = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  business_id: BIZ,
  rowboat_conversation_id: null,
  rowboat_state: null,
  title: `t-${id}`,
  is_active: id === "active",
  created_at: "2026-04-20T00:00:00Z",
  updated_at: "2026-04-25T00:00:00Z",
  message_count: 4,
  ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "owner@example.com",
    isAdmin: false
  } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
});

describe("GET /api/dashboard/chat/threads", () => {
  it("returns the serialized list under the API envelope when the caller owns the business", async () => {
    vi.mocked(listThreadsForBusiness).mockResolvedValueOnce([
      SUMMARY("active", { is_active: true, message_count: 7 }),
      SUMMARY("old", { is_active: false, message_count: 1 })
    ] as never);
    const res = await GET(urlFor(BIZ));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.threads).toEqual([
      {
        id: "active",
        title: "t-active",
        isActive: true,
        createdAt: "2026-04-20T00:00:00Z",
        updatedAt: "2026-04-25T00:00:00Z",
        messageCount: 7
      },
      {
        id: "old",
        title: "t-old",
        isActive: false,
        createdAt: "2026-04-20T00:00:00Z",
        updatedAt: "2026-04-25T00:00:00Z",
        messageCount: 1
      }
    ]);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");
    expect(listThreadsForBusiness).toHaveBeenCalledWith(BIZ);
  });

  it("returns 401 when the caller is unauthenticated and never hits the DB", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null as never);
    const res = await GET(urlFor(BIZ));
    expect(res.status).toBe(401);
    expect(requireBusinessRole).not.toHaveBeenCalled();
    expect(listThreadsForBusiness).not.toHaveBeenCalled();
  });

  it("rejects malformed businessId with VALIDATION_ERROR before any DB work", async () => {
    const res = await GET(urlFor("not-a-uuid"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(listThreadsForBusiness).not.toHaveBeenCalled();
  });

  it("rejects missing businessId param", async () => {
    const res = await GET(urlFor(null));
    expect(res.status).toBe(400);
    expect(listThreadsForBusiness).not.toHaveBeenCalled();
  });

  it("propagates owner-check rejection (cross-tenant browsing is forbidden)", async () => {
    // Anti-IDOR: an authenticated owner of business A must not be able
    // to list threads for business B by swapping the query param.
    vi.mocked(requireBusinessRole).mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 })
    );
    const res = await GET(urlFor(BIZ));
    expect(res.status).toBe(403);
    expect(listThreadsForBusiness).not.toHaveBeenCalled();
  });

  it("admin callers skip requireBusinessRole but still hit the DB", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce({
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(listThreadsForBusiness).mockResolvedValueOnce([] as never);
    const res = await GET(urlFor(BIZ));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
    expect(listThreadsForBusiness).toHaveBeenCalledWith(BIZ);
  });

  it("surfaces an unexpected DB error as a 500 envelope (no leaked stack)", async () => {
    vi.mocked(listThreadsForBusiness).mockRejectedValueOnce(new Error("db kaput"));
    const res = await GET(urlFor(BIZ));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.message).not.toContain("db kaput");
  });
});
