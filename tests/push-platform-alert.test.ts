import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push/send", () => ({
  deliverPush: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { pushPlatformAlert } from "@/lib/push/platform-alert";
import { deliverPush } from "@/lib/push/send";
import { getBusiness } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

const BIZ = "22222222-2222-2222-2222-222222222222";

function lastPush() {
  return vi.mocked(deliverPush).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, name: "Acme Realty" } as never);
  vi.mocked(deliverPush).mockResolvedValue({ ok: true, sent: 1, revoked: 0 });
});

describe("pushPlatformAlert", () => {
  it("sends to the PLATFORM scope, never to the tenant", async () => {
    // The whole point. Addressing this to the business would push the news
    // that a customer is unreachable AT that customer.
    await pushPlatformAlert({
      event: "alert_audience_dark",
      businessId: BIZ,
      silentChannels: ["sms", "email"]
    });
    expect(lastPush().scope).toEqual({ businessId: null });
  });

  it("deep links to the admin page for the business the alert is about", async () => {
    await pushPlatformAlert({
      event: "alert_delivery_failed",
      businessId: BIZ,
      failedChannels: ["sms"]
    });
    expect(lastPush().url).toBe(`/admin/${BIZ}`);
  });

  it("collapses a burst with one tag per event", async () => {
    // A systemic outage turns every tenant dark on the same sweep. Without a
    // tag that is one banner per customer, and a browser degrades a
    // permission that gets repeatedly ignored.
    await pushPlatformAlert({
      event: "alert_audience_dark",
      businessId: BIZ,
      silentChannels: ["sms"]
    });
    expect(lastPush().tag).toBe("platform-alert_audience_dark");

    vi.mocked(deliverPush).mockClear();
    await pushPlatformAlert({
      event: "alert_delivery_failed",
      businessId: BIZ,
      failedChannels: ["sms"]
    });
    expect(lastPush().tag).toBe("platform-alert_delivery_failed");
  });

  it("names the business and the channels, and nothing else", async () => {
    await pushPlatformAlert({
      event: "alert_delivery_failed",
      businessId: BIZ,
      failedChannels: ["sms", "whatsapp"]
    });
    const { title, body } = lastPush();
    expect(title).toBe("Alert delivery failed");
    expect(body).toBe("Acme Realty did not receive an urgent alert. Failed on sms, whatsapp.");
  });

  it("tells an admin to phone the customer when every channel is silent", async () => {
    await pushPlatformAlert({
      event: "alert_audience_dark",
      businessId: BIZ,
      silentChannels: ["sms", "email", "dashboard"]
    });
    expect(lastPush().body).toBe(
      "No alert channel is reaching Acme Realty. Silent: sms, email, dashboard. Call them."
    );
  });

  it("still sends when the business row cannot be read", async () => {
    // getBusiness swallows its errors and returns null. Knowing WHICH customer
    // is the nice-to-have; knowing that one of them is unreachable is the part
    // that has to survive, and the deep link still says who.
    vi.mocked(getBusiness).mockResolvedValue(null);
    await pushPlatformAlert({
      event: "alert_audience_dark",
      businessId: BIZ,
      silentChannels: ["sms"]
    });
    expect(lastPush().body).toBe("No alert channel is reaching A customer. Silent: sms. Call them.");
  });

  it("stays quiet when no admin has installed the app", async () => {
    // `not_connected` is the ordinary state until an admin registers a device.
    // Logging it as a failure would cry wolf on every single alert.
    vi.mocked(deliverPush).mockResolvedValue({ ok: false, reason: "not_connected" });
    await pushPlatformAlert({
      event: "alert_delivery_failed",
      businessId: BIZ,
      failedChannels: ["sms"]
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns on a real delivery failure", async () => {
    vi.mocked(deliverPush).mockResolvedValue({ ok: false, reason: "send_failed" });
    await pushPlatformAlert({
      event: "alert_delivery_failed",
      businessId: BIZ,
      failedChannels: ["sms"]
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "push.platformAlert: delivery failed",
      expect.objectContaining({ reason: "send_failed" })
    );
  });

  it("never throws, because it is called FROM the failure path", async () => {
    // A throw here would take down the very dispatch that was reporting a
    // problem, turning a partial delivery failure into a total one.
    vi.mocked(getBusiness).mockRejectedValue(new Error("db down"));
    await expect(
      pushPlatformAlert({
        event: "alert_audience_dark",
        businessId: BIZ,
        silentChannels: ["sms"]
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "push.platformAlert: threw",
      expect.objectContaining({ error: "db down" })
    );
  });

  it("reports a non-Error throw without stringifying it to [object Object]", async () => {
    vi.mocked(getBusiness).mockRejectedValue("just a string");
    await pushPlatformAlert({
      event: "alert_audience_dark",
      businessId: BIZ,
      silentChannels: ["sms"]
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "push.platformAlert: threw",
      expect.objectContaining({ error: "just a string" })
    );
  });
});
