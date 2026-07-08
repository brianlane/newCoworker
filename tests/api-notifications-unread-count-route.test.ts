import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/notifications", () => ({
  getUnreadNotificationCount: vi.fn()
}));

import { GET } from "@/app/api/notifications/unread-count/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { getUnreadNotificationCount } from "@/lib/db/notifications";

const BIZ = "11111111-1111-4111-8111-111111111111";

describe("api/notifications/unread-count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@example.com",
      isAdmin: false
    } as never);
    vi.mocked(requireBusinessRole).mockResolvedValue({} as never);
  });

  it("returns count for owner", async () => {
    vi.mocked(getUnreadNotificationCount).mockResolvedValue(7);
    const res = await GET(new Request(`http://localhost?businessId=${BIZ}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.count).toBe(7);
  });

  it("400 on missing businessId", async () => {
    const res = await GET(new Request("http://localhost"));
    expect(res.status).toBe(400);
  });

  it("401 when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(new Request(`http://localhost?businessId=${BIZ}`));
    expect(res.status).toBe(401);
  });
});
