import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/notifications", () => ({
  getNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn()
}));

vi.mock("@/lib/notifications/read-actor", () => ({
  resolveNotificationReadActor: vi.fn()
}));

import { GET, POST } from "@/app/api/notifications/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from "@/lib/db/notifications";
import { resolveNotificationReadActor } from "@/lib/notifications/read-actor";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";

function jsonReq(method: string, body?: unknown, qs = "") {
  return new Request(`http://localhost/api/notifications${qs}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
}

describe("api/notifications route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
    vi.mocked(resolveNotificationReadActor).mockResolvedValue("owner");
  });

  it("GET 401 when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(jsonReq("GET", undefined, `?businessId=${BIZ}`));
    expect(res.status).toBe(401);
  });

  it("GET 400 on missing businessId", async () => {
    const res = await GET(jsonReq("GET"));
    expect(res.status).toBe(400);
  });

  it("GET returns items for owner", async () => {
    vi.mocked(getNotifications).mockResolvedValue([
      {
        id: "n-1",
        business_id: BIZ,
        delivery_channel: "email",
        status: "sent",
        kind: "urgent_alert",
        summary: "URGENT",
        payload: {},
        created_at: "2026-01-01T00:00:00Z",
        read_at: null
      } as never
    ]);
    const res = await GET(jsonReq("GET", undefined, `?businessId=${BIZ}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "view_dashboard");
  });

  it("GET respects unreadOnly=1", async () => {
    vi.mocked(getNotifications).mockResolvedValue([] as never);
    await GET(jsonReq("GET", undefined, `?businessId=${BIZ}&unreadOnly=1`));
    expect(getNotifications).toHaveBeenCalledWith(BIZ, expect.objectContaining({ unreadOnly: true }));
  });

  it("POST mark_read marks one row", async () => {
    vi.mocked(markNotificationRead).mockResolvedValue({
      id: "n-1",
      business_id: BIZ,
      delivery_channel: "email",
      status: "sent",
      kind: "urgent_alert",
      summary: "URGENT",
      payload: {},
      created_at: "2026-01-01T00:00:00Z",
      read_at: "2026-05-01T00:00:00Z"
    } as never);
    const res = await POST(
      jsonReq("POST", { action: "mark_read", businessId: BIZ, id: "00000000-0000-4000-8000-000000000001" })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.marked).toBe(1);
    // The actor rides along: admin view-as reaches this route with the
    // tenant's own permissions, and its read stamp must not be able to pass
    // for the owner's in the channel-liveness check.
    expect(markNotificationRead).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      BIZ,
      "owner"
    );
  });

  it("POST mark_read returns marked:0 when row already read or not owned", async () => {
    vi.mocked(markNotificationRead).mockResolvedValue(null);
    const res = await POST(
      jsonReq("POST", { action: "mark_read", businessId: BIZ, id: "00000000-0000-4000-8000-000000000002" })
    );
    const body = await res.json();
    expect(body.data.marked).toBe(0);
  });

  it("POST mark_all_read returns count and carries the actor too", async () => {
    // mark_all_read stamps EVERY unread row, so an unattributed admin sweep
    // here would forge more owner presence than a single read ever could.
    vi.mocked(markAllNotificationsRead).mockResolvedValue(5);
    vi.mocked(resolveNotificationReadActor).mockResolvedValue("admin");
    const res = await POST(jsonReq("POST", { action: "mark_all_read", businessId: BIZ }));
    const body = await res.json();
    expect(body.data.marked).toBe(5);
    expect(markAllNotificationsRead).toHaveBeenCalledWith(BIZ, "admin");
  });

  it("POST 400 on invalid body", async () => {
    const res = await POST(jsonReq("POST", { action: "wat", businessId: BIZ }));
    expect(res.status).toBe(400);
  });

  it("POST 401 when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(jsonReq("POST", { action: "mark_all_read", businessId: BIZ }));
    expect(res.status).toBe(401);
  });
});
