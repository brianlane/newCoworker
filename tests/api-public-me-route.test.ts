import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-api/auth", () => ({
  authenticatePublicApiRequest: vi.fn()
}));

const singleMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ single: singleMock }))
      }))
    }))
  }))
}));

import { GET } from "@/app/api/public/v1/me/route";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";

const AUTH = { businessId: "biz-1", apiKeyId: "key-1" };

function req(): Request {
  return new Request("http://localhost/api/public/v1/me");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/public/v1/me", () => {
  it("401s without a valid API key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns the business identity for a valid key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(AUTH);
    singleMock.mockResolvedValue({
      data: {
        id: "biz-1",
        name: "Amy's Painting",
        tier: "standard",
        status: "online",
        timezone: "America/Phoenix"
      },
      error: null
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      business_id: "biz-1",
      name: "Amy's Painting",
      tier: "standard",
      status: "online",
      timezone: "America/Phoenix"
    });
  });

  it("404s when the business row is missing", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(AUTH);
    singleMock.mockResolvedValue({ data: null, error: { message: "no rows" } });
    const res = await GET(req());
    expect(res.status).toBe(404);
  });
});
