import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn().mockResolvedValue(undefined)
}));

import { recordSystemLog } from "@/lib/db/system-logs";
import { logAdminAction, ADMIN_AUDIT_SOURCE } from "@/lib/admin/audit";

describe("logAdminAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes an info system_log with source admin, namespaced event, and detail payload", async () => {
    await logAdminAction({
      adminEmail: "ops@newcoworker.com",
      action: "force_refund",
      businessId: "b-1",
      detail: { amountCents: 9900 }
    });

    expect(recordSystemLog).toHaveBeenCalledWith({
      businessId: "b-1",
      source: ADMIN_AUDIT_SOURCE,
      level: "info",
      event: "admin.force_refund",
      message: "ops@newcoworker.com ran force refund",
      payload: { adminEmail: "ops@newcoworker.com", amountCents: 9900 }
    });
  });

  it("tolerates a null admin email and a missing businessId/detail", async () => {
    await logAdminAction({ adminEmail: null, action: "view_as" });

    expect(recordSystemLog).toHaveBeenCalledWith({
      businessId: null,
      source: ADMIN_AUDIT_SOURCE,
      level: "info",
      event: "admin.view_as",
      message: "unknown-admin ran view as",
      payload: { adminEmail: "unknown-admin" }
    });
  });
});
