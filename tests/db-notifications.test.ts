import { describe, it, expect, vi, beforeEach } from "vitest";
import { insertNotification, getNotifications } from "@/lib/db/notifications";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_NOTIF = {
  id: "notif-uuid-1",
  business_id: "biz-uuid-1",
  delivery_channel: "sms",
  status: "sent",
  payload: { summary: "Urgent event" },
  created_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
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
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: [MOCK_NOTIF], error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getNotifications("biz-uuid-1");
    expect(result).toHaveLength(1);
  });

  it("getNotifications throws on error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getNotifications("biz-uuid-1")).rejects.toThrow("getNotifications");
  });

  it("getNotifications returns empty array when data is null with no error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: null }) };
    const result = await getNotifications("biz-uuid-1", 20, db as never);
    expect(result).toEqual([]);
  });

  it("getNotifications uses provided client", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: [MOCK_NOTIF], error: null }) };
    const result = await getNotifications("biz-uuid-1", 5, db as never);
    expect(result).toHaveLength(1);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
