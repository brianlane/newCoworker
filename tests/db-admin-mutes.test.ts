import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAdminMutedBusinessIds,
  setAdminNotificationMutes
} from "@/lib/db/admin-mutes";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MUTED_ROWS = [
  {
    id: "biz-activity",
    admin_mute_activity: true,
    admin_mute_errors: false,
    admin_mute_alerts: false
  },
  {
    id: "biz-errors-alerts",
    admin_mute_activity: false,
    admin_mute_errors: true,
    admin_mute_alerts: true
  }
];

describe("db/admin-mutes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getAdminMutedBusinessIds groups muted ids per feed", async () => {
    const or = vi.fn().mockResolvedValue({ data: MUTED_ROWS, error: null });
    const db = { from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), or };
    const result = await getAdminMutedBusinessIds(db as never);
    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(or).toHaveBeenCalledWith(
      "admin_mute_activity.eq.true,admin_mute_errors.eq.true,admin_mute_alerts.eq.true"
    );
    expect(result).toEqual({
      activity: ["biz-activity"],
      errors: ["biz-errors-alerts"],
      alerts: ["biz-errors-alerts"]
    });
  });

  it("getAdminMutedBusinessIds returns empty sets when data is null", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    await expect(getAdminMutedBusinessIds(db as never)).resolves.toEqual({
      activity: [],
      errors: [],
      alerts: []
    });
  });

  it("getAdminMutedBusinessIds falls back to the service client", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({ data: [], error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await getAdminMutedBusinessIds();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("getAdminMutedBusinessIds throws on query error", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    };
    await expect(getAdminMutedBusinessIds(db as never)).rejects.toThrow(
      "getAdminMutedBusinessIds: boom"
    );
  });

  function updateChain(result: { data: unknown; error: { message: string } | null }) {
    const single = vi.fn().mockResolvedValue(result);
    const chain = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single
    };
    return chain;
  }

  it("setAdminNotificationMutes patches only provided switches", async () => {
    const db = updateChain({
      data: { admin_mute_activity: true, admin_mute_errors: false, admin_mute_alerts: true },
      error: null
    });
    const result = await setAdminNotificationMutes(
      "biz-1",
      { muteActivity: true, muteAlerts: true },
      db as never
    );
    expect(db.update).toHaveBeenCalledWith({
      admin_mute_activity: true,
      admin_mute_alerts: true
    });
    expect(db.eq).toHaveBeenCalledWith("id", "biz-1");
    expect(result).toEqual({ muteActivity: true, muteErrors: false, muteAlerts: true });
  });

  it("setAdminNotificationMutes patches the errors switch alone", async () => {
    const db = updateChain({
      data: { admin_mute_activity: false, admin_mute_errors: true, admin_mute_alerts: false },
      error: null
    });
    const result = await setAdminNotificationMutes("biz-1", { muteErrors: true }, db as never);
    expect(db.update).toHaveBeenCalledWith({ admin_mute_errors: true });
    expect(result).toEqual({ muteActivity: false, muteErrors: true, muteAlerts: false });
  });

  it("setAdminNotificationMutes falls back to the service client", async () => {
    const db = updateChain({
      data: { admin_mute_activity: false, admin_mute_errors: false, admin_mute_alerts: false },
      error: null
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await setAdminNotificationMutes("biz-1", { muteActivity: false });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("setAdminNotificationMutes throws on update error", async () => {
    const db = updateChain({ data: null, error: { message: "denied" } });
    await expect(
      setAdminNotificationMutes("biz-1", { muteAlerts: true }, db as never)
    ).rejects.toThrow("setAdminNotificationMutes: denied");
  });
});
