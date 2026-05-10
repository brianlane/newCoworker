import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/notification-preferences", () => ({
  getOrCreateNotificationPreferences: vi.fn()
}));

vi.mock("@/lib/db/notifications", () => ({
  insertNotification: vi.fn(async () => ({ id: "x" }))
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn()
}));

vi.mock("@/lib/telnyx/messaging", () => ({
  sendTelnyxSms: vi.fn(),
  getTelnyxMessagingForBusiness: vi.fn(async () => ({
    apiKey: "k",
    messagingProfileId: "mp"
  }))
}));

import {
  dispatchUrgentNotification,
  resolveNotificationTargets
} from "@/lib/notifications/dispatch";
import { getBusiness } from "@/lib/db/businesses";
import { getOrCreateNotificationPreferences } from "@/lib/db/notification-preferences";
import { insertNotification } from "@/lib/db/notifications";
import { sendOwnerEmail } from "@/lib/email/client";
import { sendTelnyxSms } from "@/lib/telnyx/messaging";

const BIZ = "11111111-1111-4111-8111-111111111111";

const PREFS_ON = {
  business_id: BIZ,
  sms_urgent: true,
  email_urgent: true,
  email_digest: true,
  dashboard_alerts: true,
  alert_email: null,
  phone_number: null,
  unsubscribed_at: null,
  updated_at: "2026-01-01T00:00:00Z"
};

const BUSINESS = { id: BIZ, owner_email: "owner@example.com" };

describe("notifications/dispatch", () => {
  const original = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...original,
      ADMIN_EMAIL: "admin@example.com",
      TELNYX_OWNER_PHONE: "+15555550100",
      RESEND_API_KEY: "re_test",
      NEXT_PUBLIC_APP_URL: "https://app.example.com"
    };
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue(PREFS_ON as never);
    vi.mocked(getBusiness).mockResolvedValue(BUSINESS as never);
  });
  afterEach(() => {
    process.env = original;
  });

  it("resolveNotificationTargets prefers per-business prefs over owner_email and env", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      alert_email: "biz-alert@example.com",
      phone_number: "+15555550199"
    } as never);
    const t = await resolveNotificationTargets(BIZ);
    expect(t.email).toBe("biz-alert@example.com");
    expect(t.phone).toBe("+15555550199");
  });

  it("resolveNotificationTargets falls back to owner_email when prefs.alert_email is null", async () => {
    const t = await resolveNotificationTargets(BIZ);
    expect(t.email).toBe("owner@example.com");
    expect(t.phone).toBe("+15555550100"); // env fallback for phone
  });

  it("resolveNotificationTargets falls back to ADMIN_EMAIL when no prefs/business email", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      alert_email: null
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const t = await resolveNotificationTargets(BIZ);
    expect(t.email).toBe("admin@example.com");
  });

  it("dispatchUrgentNotification writes 3 sent rows and calls senders when toggles on", async () => {
    vi.mocked(sendOwnerEmail).mockResolvedValue("email_id" as never);
    vi.mocked(sendTelnyxSms).mockResolvedValue("sms_id" as never);
    const result = await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT call",
      kind: "urgent_alert"
    });

    expect(sendOwnerEmail).toHaveBeenCalledTimes(1);
    expect(sendTelnyxSms).toHaveBeenCalledTimes(1);
    const inserts = vi.mocked(insertNotification).mock.calls.map((c) => c[0] as Record<string, unknown>);
    const channelStatus = inserts.map((r) => `${r.delivery_channel}:${r.status}`);
    expect(channelStatus).toEqual(
      expect.arrayContaining(["dashboard:sent", "email:sent", "sms:sent"])
    );
    expect(result.results.find((r) => r.channel === "email")?.status).toBe("sent");
  });

  it("skips email when email_urgent toggle is off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      email_urgent: false
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("skipped");
    expect((emailRow?.payload as Record<string, unknown>).reason).toBe("email_urgent_disabled");
  });

  it("skips SMS when sms_urgent toggle is off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      sms_urgent: false
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    expect(sendTelnyxSms).not.toHaveBeenCalled();
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("skipped");
  });

  it("skips dashboard channel when dashboard_alerts is off", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      dashboard_alerts: false
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const dashRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "dashboard");
    expect(dashRow?.status).toBe("skipped");
    expect((dashRow?.payload as Record<string, unknown>).reason).toBe("dashboard_alerts_disabled");
  });

  it("hard-skips ALL channels when unsubscribed_at is set, even if toggles are on", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      unsubscribed_at: "2026-05-01T00:00:00Z"
    } as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    expect(sendTelnyxSms).not.toHaveBeenCalled();
    const rows = vi.mocked(insertNotification).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows.every((r) => r.status === "skipped")).toBe(true);
    expect(rows.every((r) => (r.payload as Record<string, unknown>).reason === "unsubscribed")).toBe(
      true
    );
  });

  it("records failed status when email send throws", async () => {
    vi.mocked(sendOwnerEmail).mockRejectedValue(new Error("resend down"));
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("failed");
    expect((emailRow?.payload as Record<string, unknown>).reason).toContain("resend down");
  });

  it("records failed status when SMS send throws", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("telnyx down"));
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("failed");
  });

  it("records skipped:no_email when no email recipient resolvable", async () => {
    delete process.env.ADMIN_EMAIL;
    vi.mocked(getOrCreateNotificationPreferences).mockResolvedValue({
      ...PREFS_ON,
      alert_email: null
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("skipped");
    expect((emailRow?.payload as Record<string, unknown>).reason).toBe("no_email");
  });

  it("records skipped:no_phone when phone unresolvable", async () => {
    delete process.env.TELNYX_OWNER_PHONE;
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("skipped");
    expect((smsRow?.payload as Record<string, unknown>).reason).toBe("no_phone");
  });

  it("passes unsubscribe URL anchored at the app origin with bid=<uuid>", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const call = vi.mocked(sendOwnerEmail).mock.calls[0];
    const opts = call[3] as { unsubscribeUrl?: string | null };
    expect(opts.unsubscribeUrl).toBe(
      `https://app.example.com/api/notifications/unsubscribe?bid=${encodeURIComponent(BIZ)}`
    );
    // Must NOT live under /dashboard (regression for the original bot finding).
    expect(opts.unsubscribeUrl).not.toContain("/dashboard/api/");
  });

  it("does not crash when prefs lookup throws — falls through to env defaults", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockRejectedValue(new Error("db blip"));
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    // env has phone + admin/owner email; defaults are toggles-on
    expect(sendOwnerEmail).toHaveBeenCalled();
    expect(sendTelnyxSms).toHaveBeenCalled();
  });

  it("does not crash when business lookup throws", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("biz blip"));
    const t = await resolveNotificationTargets(BIZ);
    // owner_email lookup failed → falls back to ADMIN_EMAIL
    expect(t.email).toBe("admin@example.com");
  });

  it("swallows insertNotification failures (best-effort history)", async () => {
    vi.mocked(insertNotification).mockRejectedValue(new Error("db gone"));
    // Should not throw even though every history-row write fails.
    await expect(
      dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      })
    ).resolves.toBeDefined();
  });

  it("swallows non-Error insert failures (e.g. plain string thrown)", async () => {
    // Throw a non-Error value to exercise the `String(err)` branch in the logger.
    vi.mocked(insertNotification).mockRejectedValue("plain string error");
    await expect(
      dispatchUrgentNotification({
        businessId: BIZ,
        summary: "URGENT",
        kind: "urgent_alert"
      })
    ).resolves.toBeDefined();
  });

  it("records fallback reason when email sender throws non-Error", async () => {
    vi.mocked(sendOwnerEmail).mockRejectedValue("string-error");
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const emailRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "email");
    expect(emailRow?.status).toBe("failed");
    expect((emailRow?.payload as Record<string, unknown>).reason).toBe("send_failed");
  });

  it("records fallback reason when SMS sender throws non-Error", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue("string-error");
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const smsRow = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((r) => r.delivery_channel === "sms");
    expect(smsRow?.status).toBe("failed");
    expect((smsRow?.payload as Record<string, unknown>).reason).toBe("send_failed");
  });

  it("logs business-lookup failure with non-Error rejection (String(err) branch)", async () => {
    vi.mocked(getBusiness).mockRejectedValue("plain rejection");
    await resolveNotificationTargets(BIZ);
  });

  it("logs prefs-lookup failure with non-Error rejection", async () => {
    vi.mocked(getOrCreateNotificationPreferences).mockRejectedValue("blip");
    await resolveNotificationTargets(BIZ);
  });

  it("strips a trailing slash from NEXT_PUBLIC_APP_URL so no double-slash leaks into emails", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert"
    });
    const call = vi.mocked(sendOwnerEmail).mock.calls[0];
    const opts = call[3] as { unsubscribeUrl?: string | null; text?: string };
    expect(opts.unsubscribeUrl).toBe(
      `https://app.example.com/api/notifications/unsubscribe?bid=${encodeURIComponent(BIZ)}`
    );
    expect(opts.unsubscribeUrl).not.toContain("//api/");
    expect(opts.text).toContain("https://app.example.com/dashboard");
    expect(opts.text).not.toContain("//dashboard");
  });

  it("uses fallback dashboardUrl + empty RESEND_API_KEY when env vars unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_API_KEY;
    vi.mocked(sendOwnerEmail).mockResolvedValue("ok" as never);
    vi.mocked(sendTelnyxSms).mockResolvedValue("ok" as never);
    await dispatchUrgentNotification({
      businessId: BIZ,
      summary: "URGENT",
      kind: "urgent_alert",
      payload: { extra: "ctx" }
    });
    // sendOwnerEmail invoked with empty apiKey (??"" branch)
    const call = vi.mocked(sendOwnerEmail).mock.calls[0];
    expect(call[0]).toBe("");
    // dashboard URL fallback shows up in the synthesized email body.
    const body = (call[3] as { text: string }).text;
    expect(body).toContain("http://localhost:3000/dashboard");
  });
});
