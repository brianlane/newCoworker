import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  insertNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  softDeleteNotification
} from "@/lib/db/notifications";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/residency/row-delete", () => ({
  softDeleteContentRows: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { softDeleteContentRows } from "@/lib/residency/row-delete";

const MOCK_NOTIF = {
  id: "notif-uuid-1",
  business_id: "biz-uuid-1",
  delivery_channel: "sms",
  status: "sent",
  payload: { summary: "Urgent event" },
  created_at: "2026-01-01T00:00:00Z",
  read_at: null,
  kind: "urgent_alert",
  summary: "Urgent event"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: MOCK_NOTIF, error: null }),
    single: vi.fn().mockResolvedValue({ data: MOCK_NOTIF, error: null }),
    ...overrides
  };
}

describe("db/notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insertNotification inserts and returns row", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await insertNotification({
      id: "notif-uuid-1",
      business_id: "biz-uuid-1",
      delivery_channel: "sms",
      status: "sent",
      payload: { summary: "Urgent event" }
    });
    expect(result.delivery_channel).toBe("sms");
  });

  it("insertNotification accepts new optional kind/summary/read_at fields", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await insertNotification({
      id: "notif-uuid-1",
      business_id: "biz-uuid-1",
      delivery_channel: "email",
      status: "skipped",
      payload: { reason: "unsubscribed" },
      kind: "urgent_alert",
      summary: "URGENT call"
    });
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "urgent_alert", summary: "URGENT call" })
    );
  });

  it("insertNotification throws on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(insertNotification({
      id: "x",
      business_id: "y",
      delivery_channel: "email",
      status: "queued",
      payload: {}
    })).rejects.toThrow("insertNotification");
  });

  it("getNotifications returns array", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [MOCK_NOTIF], error: null });
    const db = { ...mockDb(), limit };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getNotifications("biz-uuid-1");
    expect(result).toHaveLength(1);
  });

  it("getNotifications throws on error", async () => {
    const limit = vi.fn().mockResolvedValue({ data: null, error: { message: "err" } });
    const db = { ...mockDb(), limit };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getNotifications("biz-uuid-1")).rejects.toThrow("getNotifications");
  });

  it("getNotifications returns empty array when data is null with no error", async () => {
    const limit = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = { ...mockDb(), limit };
    const result = await getNotifications("biz-uuid-1", 20, db as never);
    expect(result).toEqual([]);
  });

  it("getNotifications uses provided client (legacy number signature)", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [MOCK_NOTIF], error: null });
    const db = { ...mockDb(), limit };
    const result = await getNotifications("biz-uuid-1", 5, db as never);
    expect(result).toHaveLength(1);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("getNotifications options object: applies unreadOnly filter via .is()", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const is = vi.fn().mockReturnThis();
    const db = { ...mockDb(), is, limit };
    await getNotifications("biz-uuid-1", { unreadOnly: true, limit: 10 }, db as never);
    expect(is).toHaveBeenCalledWith("read_at", null);
    expect(limit).toHaveBeenCalledWith(10);
  });

  it("getNotifications options bag: defaults limit to 20 when omitted", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const db = { ...mockDb(), limit };
    await getNotifications("biz-uuid-1", { unreadOnly: false }, db as never);
    expect(limit).toHaveBeenCalledWith(20);
  });

  /**
   * The unread-count chain now ends with TWO .is() calls
   * (read_at, then deleted_at): the first must return the chain,
   * the second resolves the query.
   */
  function unreadCountChain(result: { count: number | null; error: { message: string } | null }) {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      // Residency-mode lookup (from("businesses")…maybeSingle) shares this
      // mock; null data resolves to central ("supabase") mode.
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      is: vi.fn()
    };
    chain.is.mockReturnValueOnce(chain).mockResolvedValueOnce(result);
    return chain;
  }

  it("getUnreadNotificationCount returns count and filters by status='sent'", async () => {
    const chain = unreadCountChain({ count: 4, error: null });
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getUnreadNotificationCount("biz-uuid-1")).toBe(4);
    // Bell badge must NOT count audit-only skipped/failed rows.
    expect(chain.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
    expect(chain.eq).toHaveBeenCalledWith("status", "sent");
    expect(chain.is).toHaveBeenCalledWith("read_at", null);
    // Soft-deleted rows must never inflate the bell badge.
    expect(chain.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("getUnreadNotificationCount returns 0 when count is null", async () => {
    const chain = unreadCountChain({ count: null, error: null });
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getUnreadNotificationCount("biz-uuid-1")).toBe(0);
  });

  it("getUnreadNotificationCount throws on error", async () => {
    const chain = unreadCountChain({ count: null, error: { message: "boom" } });
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getUnreadNotificationCount("biz-uuid-1")).rejects.toThrow(
      "getUnreadNotificationCount"
    );
  });

  it("markNotificationRead returns the updated row", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { ...MOCK_NOTIF, read_at: "2026-05-01T00:00:00Z" },
        error: null
      })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await markNotificationRead("notif-uuid-1", "biz-uuid-1");
    expect(row?.read_at).toBe("2026-05-01T00:00:00Z");
    expect(chain.eq).toHaveBeenCalledWith("id", "notif-uuid-1");
    expect(chain.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
    expect(chain.is).toHaveBeenCalledWith("read_at", null);
  });

  it("markNotificationRead returns null when no row matched (already read or wrong owner)", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markNotificationRead("nope", "biz")).toBeNull();
  });

  it("markNotificationRead throws on db error", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "x" } })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(markNotificationRead("n", "b")).rejects.toThrow("markNotificationRead");
  });

  it("markAllNotificationsRead returns count of rows updated", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: "1" }, { id: "2" }], error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markAllNotificationsRead("biz")).toBe(2);
  });

  it("markAllNotificationsRead returns 0 when supabase returns null with no error", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markAllNotificationsRead("biz")).toBe(0);
  });

  it("markAllNotificationsRead throws on db error", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "x" } })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(markAllNotificationsRead("biz")).rejects.toThrow("markAllNotificationsRead");
  });

  it("getNotifications filters out soft-deleted rows", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const is = vi.fn().mockReturnThis();
    const db = { ...mockDb(), is, limit };
    await getNotifications("biz-uuid-1", 20, db as never);
    expect(is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("softDeleteNotification delegates to the residency-aware soft delete", async () => {
    vi.mocked(softDeleteContentRows).mockResolvedValue({ central: 1, box: null });
    const db = mockDb();
    const count = await softDeleteNotification("biz-uuid-1", "notif-uuid-1", "user-1", db as never);
    expect(count).toBe(1);
    expect(softDeleteContentRows).toHaveBeenCalledWith(
      "biz-uuid-1",
      "notifications",
      [{ column: "id", op: "eq", value: "notif-uuid-1" }],
      "user-1",
      { client: db }
    );
  });

  it("softDeleteNotification counts box-only stamps (vps-mode purged central)", async () => {
    vi.mocked(softDeleteContentRows).mockResolvedValue({ central: 0, box: 1 });
    expect(await softDeleteNotification("biz", "n1", null)).toBe(1);
    expect(softDeleteContentRows).toHaveBeenCalledWith(
      "biz",
      "notifications",
      [{ column: "id", op: "eq", value: "n1" }],
      null,
      {}
    );
  });
});
