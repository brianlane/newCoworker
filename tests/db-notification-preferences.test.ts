import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getNotificationPreferences,
  getOrCreateNotificationPreferences,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const PREFS = {
  business_id: "biz-1",
  sms_urgent: true,
  email_digest: true,
  email_urgent: true,
  dashboard_alerts: true,
  phone_number: null,
  alert_email: null,
  updated_at: "2026-01-01T00:00:00Z"
};

describe("db/notification-preferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getNotificationPreferences returns row", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getNotificationPreferences("biz-1");
    expect(row?.business_id).toBe("biz-1");
  });

  it("getNotificationPreferences returns null when missing", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getNotificationPreferences("biz-1")).resolves.toBeNull();
  });

  it("getNotificationPreferences throws on error", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getNotificationPreferences("biz-1")).rejects.toThrow("getNotificationPreferences");
  });

  it("getOrCreateNotificationPreferences returns existing", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOrCreateNotificationPreferences("biz-1");
    expect(row.business_id).toBe("biz-1");
  });

  it("getOrCreateNotificationPreferences inserts when missing", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(insertChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOrCreateNotificationPreferences("biz-1");
    expect(row.business_id).toBe("biz-1");
    expect(insertChain.insert).toHaveBeenCalled();
  });

  it("getOrCreateNotificationPreferences throws on insert error", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "dup" } })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(insertChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getOrCreateNotificationPreferences("biz-1")).rejects.toThrow(
      "getOrCreateNotificationPreferences"
    );
  });

  it("updateNotificationPreferences updates", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, sms_urgent: false },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await updateNotificationPreferences("biz-1", { sms_urgent: false });
    expect(row.sms_urgent).toBe(false);
    expect(updateChain.update).toHaveBeenCalled();
  });

  it("updateNotificationPreferences can set sms_urgent to true", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { ...PREFS, sms_urgent: false }, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, sms_urgent: true },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await updateNotificationPreferences("biz-1", { sms_urgent: true });
    expect(row.sms_urgent).toBe(true);
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ sms_urgent: true })
    );
  });

  it("updateNotificationPreferences omits unchanged fields from patch", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, email_digest: false },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateNotificationPreferences("biz-1", { email_digest: false });
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        email_digest: false,
        updated_at: expect.any(String)
      })
    );
    const payload = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("sms_urgent");
  });

  it("updateNotificationPreferences applies all patch fields with shared client", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          ...PREFS,
          phone_number: "+1",
          alert_email: "a@b.com",
          email_digest: false
        },
        error: null
      })
    };
    const shared = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };

    const row = await updateNotificationPreferences(
      "biz-1",
      {
        sms_urgent: false,
        email_urgent: true,
        dashboard_alerts: false,
        phone_number: "+1",
        alert_email: "a@b.com",
        email_digest: false
      },
      shared as never
    );
    expect(row.phone_number).toBe("+1");
    expect(row.alert_email).toBe("a@b.com");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sms_urgent: false,
        email_urgent: true,
        dashboard_alerts: false,
        phone_number: "+1",
        alert_email: "a@b.com",
        email_digest: false
      })
    );
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("updateNotificationPreferences throws on update error", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateNotificationPreferences("biz-1", { sms_urgent: false })).rejects.toThrow(
      "updateNotificationPreferences"
    );
  });

  it("getNotificationPreferences uses injected client", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    await getNotificationPreferences("biz-1", db as never);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
