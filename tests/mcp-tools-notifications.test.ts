import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/notifications/preferences-tool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/preferences-tool")>();
  return { ...actual, applyNotificationPreferenceToggles: vi.fn() };
});
vi.mock("@/lib/db/notification-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/notification-preferences")>();
  return { ...actual, getNotificationPreferences: vi.fn() };
});

import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  getNotificationPreferencesTool,
  updateNotificationPreferencesTool
} from "@/lib/mcp/tools/notifications";
import { applyNotificationPreferenceToggles } from "@/lib/notifications/preferences-tool";
import {
  defaultNotificationPreferencesRow,
  getNotificationPreferences
} from "@/lib/db/notification-preferences";

/**
 * Claude-connector notification tools: manage_settings-gated (manager+, the
 * same matrix as the settings page), boolean toggles only. The update tool
 * rides the shared whitelist core; the read tool answers the toggle map plus
 * whether alert recipients are configured — never the recipients themselves
 * (no need to hand PII to the model to answer "is it on?").
 */

const AUTH = { userId: "user-1", email: "owner@biz.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner" as never);
  vi.mocked(getNotificationPreferences).mockResolvedValue({
    ...defaultNotificationPreferencesRow("biz-1"),
    customer_reply_alerts: true,
    phone_number: "+15145188192",
    alert_email: null
  });
  vi.mocked(applyNotificationPreferenceToggles).mockResolvedValue({
    ok: true,
    data: {
      updated: { customer_reply_alerts: true },
      settings: { customer_reply_alerts: true } as never
    }
  });
});

describe("update_notification_preferences (MCP)", () => {
  it("requires manage_settings and applies toggles through the shared core", async () => {
    const result = (await updateNotificationPreferencesTool.handler(
      { customer_reply_alerts: true },
      AUTH
    )) as { updated: Record<string, boolean> };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(applyNotificationPreferenceToggles).toHaveBeenCalledWith("biz-1", {
      customer_reply_alerts: true
    });
    expect(result.updated).toEqual({ customer_reply_alerts: true });
  });

  it("declares boolean toggles only — recipients are not in the schema", () => {
    const keys = Object.keys(updateNotificationPreferencesTool.schema);
    expect(keys).toContain("customer_reply_alerts");
    expect(keys).toContain("sms_urgent");
    expect(keys).not.toContain("phone_number");
    expect(keys).not.toContain("alert_email");
    expect(keys).not.toContain("unsubscribed_at");
  });

  it("surfaces core refusals as tool errors", async () => {
    vi.mocked(applyNotificationPreferenceToggles).mockResolvedValue({
      ok: false,
      detail: "no_toggles",
      message: "Pass at least one toggle."
    });
    await expect(
      updateNotificationPreferencesTool.handler({}, AUTH)
    ).rejects.toThrow(/at least one toggle/i);

    vi.mocked(applyNotificationPreferenceToggles).mockResolvedValue({
      ok: false,
      detail: "update_failed"
    });
    await expect(
      updateNotificationPreferencesTool.handler({ sms_urgent: true }, AUTH)
    ).rejects.toThrow(/update_failed/);
  });

  it("a refused role check propagates (staff must never mutate settings)", async () => {
    vi.mocked(requireMcpBusinessRole).mockRejectedValue(
      new McpToolError("Your role does not allow this.")
    );
    await expect(
      updateNotificationPreferencesTool.handler({ customer_reply_alerts: true }, AUTH)
    ).rejects.toThrow(/role does not allow/);
    expect(applyNotificationPreferenceToggles).not.toHaveBeenCalled();
  });
});

describe("get_notification_preferences (MCP)", () => {
  it("answers the toggle map plus recipient presence, never the recipients", async () => {
    const result = (await getNotificationPreferencesTool.handler({}, AUTH)) as {
      settings: Record<string, boolean>;
      alert_phone_configured: boolean;
      alert_email_configured: boolean;
      unsubscribed: boolean;
    };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(result.settings.customer_reply_alerts).toBe(true);
    expect(result.settings.sms_urgent).toBe(true);
    expect(result.alert_phone_configured).toBe(true);
    expect(result.alert_email_configured).toBe(false);
    expect(result.unsubscribed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("+15145188192");
  });

  it("a business with no prefs row answers the registry defaults", async () => {
    vi.mocked(getNotificationPreferences).mockResolvedValue(null);
    const result = (await getNotificationPreferencesTool.handler({}, AUTH)) as {
      settings: Record<string, boolean>;
    };
    expect(result.settings.customer_reply_alerts).toBe(false);
    expect(result.settings.sms_urgent).toBe(true);
  });
});
