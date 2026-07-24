import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/notification-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/notification-preferences")>();
  return { ...actual, updateNotificationPreferences: vi.fn() };
});

import {
  NOTIFICATION_TOGGLE_KEYS,
  applyNotificationPreferenceToggles
} from "@/lib/notifications/preferences-tool";
import {
  defaultNotificationPreferencesRow,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";
import { logger } from "@/lib/logger";

/**
 * AI-surface notification toggle core (the update_notification_preferences
 * tool): boolean toggles only, whitelisted — never phone_number, alert_email,
 * digest recipients, or unsubscribed_at (a hijacked alert destination is the
 * scarier failure than a flipped boolean). The SMS surface passes
 * enableOnly, which refuses every `false` so an injected customer can never
 * SILENCE the owner's alerts.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateNotificationPreferences).mockImplementation(async (businessId, patch) => ({
    ...defaultNotificationPreferencesRow(businessId),
    ...patch
  }));
});

describe("applyNotificationPreferenceToggles", () => {
  it("whitelists exactly the boolean toggles (recipients and unsubscribe are untouchable)", () => {
    expect([...NOTIFICATION_TOGGLE_KEYS].sort()).toEqual(
      [
        "customer_reply_alerts",
        "aiflow_failure_alerts",
        "unassigned_booking_alerts",
        "sms_urgent",
        "whatsapp_urgent",
        "email_urgent",
        "email_digest",
        "email_digest_weekly",
        "digest_customer_facing_only",
        "dashboard_alerts",
        "sms_warm_transfer",
        "image_limit_alerts",
        "category_leads",
        "category_team",
        "category_system"
      ].sort()
    );
    expect(NOTIFICATION_TOGGLE_KEYS).not.toContain("phone_number");
    expect(NOTIFICATION_TOGGLE_KEYS).not.toContain("alert_email");
    expect(NOTIFICATION_TOGGLE_KEYS).not.toContain("unsubscribed_at");
  });

  it("applies whitelisted toggles through the settings-page core and answers the resulting state", async () => {
    const result = await applyNotificationPreferenceToggles(BIZ, {
      customer_reply_alerts: true,
      email_digest: false
    });
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      BIZ,
      { customer_reply_alerts: true, email_digest: false },
      undefined
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.updated).toEqual({ customer_reply_alerts: true, email_digest: false });
      // The full toggle map so the model can confirm state honestly.
      expect(result.data.settings.customer_reply_alerts).toBe(true);
      expect(result.data.settings.email_digest).toBe(false);
      expect(result.data.settings.sms_urgent).toBe(true);
      // Never leaks non-toggle columns.
      expect(Object.keys(result.data.settings).sort()).toEqual(
        [...NOTIFICATION_TOGGLE_KEYS].sort()
      );
    }
  });

  it("refuses unknown keys with guidance and never writes", async () => {
    const result = await applyNotificationPreferenceToggles(BIZ, {
      customer_reply_alerts: true,
      phone_number: "+15551234567"
    });
    expect(result).toMatchObject({ ok: false, detail: "unknown_toggle:phone_number" });
    if (!result.ok) {
      expect(result.message).toContain("customer_reply_alerts");
    }
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("refuses non-boolean values and empty toggle sets without writing", async () => {
    const bad = await applyNotificationPreferenceToggles(BIZ, { sms_urgent: "yes" });
    expect(bad).toMatchObject({ ok: false, detail: "invalid_value:sms_urgent" });

    const empty = await applyNotificationPreferenceToggles(BIZ, {});
    expect(empty).toMatchObject({ ok: false, detail: "no_toggles" });
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("enableOnly refuses any false value with dashboard guidance (SMS surface can only turn alerts ON)", async () => {
    const result = await applyNotificationPreferenceToggles(
      BIZ,
      { customer_reply_alerts: true, sms_urgent: false },
      { enableOnly: true }
    );
    expect(result).toMatchObject({ ok: false, detail: "enable_only_surface" });
    if (!result.ok) {
      expect(result.message).toMatch(/turn(ing)? .*off/i);
      expect(result.message).toContain("dashboard");
    }
    expect(updateNotificationPreferences).not.toHaveBeenCalled();

    // All-true sets pass through enableOnly unchanged.
    const enabled = await applyNotificationPreferenceToggles(
      BIZ,
      { customer_reply_alerts: true },
      { enableOnly: true }
    );
    expect(enabled.ok).toBe(true);
  });

  it("enableOnly refuses quieting toggles even when set to true (enabling them SILENCES email)", async () => {
    // digest_customer_facing_only inverts the enable-only threat model:
    // "on" means fewer digest emails, so an injected customer could use it
    // to quiet the owner. The texting surface must refuse it outright.
    const result = await applyNotificationPreferenceToggles(
      BIZ,
      { digest_customer_facing_only: true },
      { enableOnly: true }
    );
    expect(result).toMatchObject({ ok: false, detail: "enable_only_surface" });
    expect(updateNotificationPreferences).not.toHaveBeenCalled();

    // Role-verified surfaces (dashboard chat, MCP) flip it freely.
    const dashboard = await applyNotificationPreferenceToggles(BIZ, {
      digest_customer_facing_only: true
    });
    expect(dashboard.ok).toBe(true);
    if (dashboard.ok) {
      expect(dashboard.data.updated).toEqual({ digest_customer_facing_only: true });
      expect(dashboard.data.settings.digest_customer_facing_only).toBe(true);
    }
  });

  it("skips undefined values and defaults missing row columns to false", async () => {
    // undefined = "not mentioned" (the zod-optional shape both tool surfaces
    // produce) — never written, never counted as a toggle.
    const result = await applyNotificationPreferenceToggles(BIZ, {
      customer_reply_alerts: true,
      sms_urgent: undefined
    });
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      BIZ,
      { customer_reply_alerts: true },
      undefined
    );
    expect(result.ok).toBe(true);

    // Rows read before a toggle column existed (e.g. whatsapp_urgent) answer
    // false rather than leaking undefined into the model-facing map.
    const legacyRow = defaultNotificationPreferencesRow(BIZ);
    delete (legacyRow as Record<string, unknown>).whatsapp_urgent;
    vi.mocked(updateNotificationPreferences).mockResolvedValueOnce(legacyRow);
    const legacy = await applyNotificationPreferenceToggles(BIZ, { category_leads: true });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.data.settings.whatsapp_urgent).toBe(false);
  });

  it("passes an injected client through to the settings core", async () => {
    const client = { tag: "fake" } as never;
    await applyNotificationPreferenceToggles(BIZ, { category_leads: true }, {}, client);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      BIZ,
      { category_leads: true },
      client
    );
  });

  it("a thrown settings write answers update_failed and never throws (Error AND string shapes)", async () => {
    vi.mocked(updateNotificationPreferences).mockRejectedValueOnce(new Error("db down"));
    const result = await applyNotificationPreferenceToggles(BIZ, { sms_urgent: true });
    expect(result).toMatchObject({ ok: false, detail: "update_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "notification preferences tool: update failed",
      expect.objectContaining({ businessId: BIZ, error: "db down" })
    );

    vi.mocked(updateNotificationPreferences).mockRejectedValueOnce("string blast");
    const again = await applyNotificationPreferenceToggles(BIZ, { sms_urgent: true });
    expect(again).toMatchObject({ ok: false, detail: "update_failed" });
  });
});
