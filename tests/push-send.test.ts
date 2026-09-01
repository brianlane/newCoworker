import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("web-push", () => {
  class WebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "WebPushError";
      this.statusCode = statusCode;
    }
  }
  return {
    default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() },
    WebPushError
  };
});

vi.mock("@/lib/push/db", () => ({
  listDeliverablePushSubscriptions: vi.fn(),
  revokePushSubscription: vi.fn(),
  revokePushSubscriptionsForUser: vi.fn(),
  stampPushSent: vi.fn()
}));

vi.mock("@/lib/push/tier-gate", () => ({
  pushAllowedForBusiness: vi.fn()
}));

vi.mock("@/lib/push/eligibility", async () => {
  const actual = await vi.importActual<typeof import("@/lib/push/eligibility")>(
    "@/lib/push/eligibility"
  );
  return { ...actual, listEligiblePushUserIds: vi.fn() };
});

import webpush, { WebPushError } from "web-push";
import { deliverPush } from "@/lib/push/send";
import {
  listDeliverablePushSubscriptions,
  revokePushSubscription,
  revokePushSubscriptionsForUser,
  stampPushSent
} from "@/lib/push/db";
import { listEligiblePushUserIds } from "@/lib/push/eligibility";
import { pushAllowedForBusiness } from "@/lib/push/tier-gate";

const BIZ = "11111111-1111-1111-1111-111111111111";

/**
 * The runtime mock above only needs (message, statusCode), but `npx tsc
 * --noEmit` checks this file against the real @types/web-push, whose
 * constructor takes five arguments. One helper keeps both happy.
 */
function pushError(statusCode: number): WebPushError {
  return new WebPushError(
    "push service refused",
    statusCode,
    {},
    "",
    "https://fcm.googleapis.com/fcm/send/one"
  );
}


function row(over: Partial<{ id: string; endpoint: string; user_id: string }> = {}) {
  return {
    id: over.id ?? "sub-1",
    business_id: BIZ,
    user_id: over.user_id ?? "user-1",
    endpoint: over.endpoint ?? "https://fcm.googleapis.com/fcm/send/one",
    p256dh: "key",
    auth: "auth",
    device_label: "iPhone Safari",
    last_seen_at: "2026-08-28T00:00:00Z",
    revoked_at: null
  };
}

const INPUT = { scope: { businessId: BIZ }, title: "Alert", body: "Body", url: "/dashboard" };

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.VAPID_PUBLIC_KEY = "pub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  process.env.VAPID_SUBJECT = "mailto:a@b.com";
  vi.mocked(pushAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([row()]);
  vi.mocked(listEligiblePushUserIds).mockResolvedValue(new Set(["user-1"]));
  vi.mocked(webpush.sendNotification).mockResolvedValue({} as never);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("push/send: deliverPush", () => {
  it("delivers to every live device and reports the count", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "a", endpoint: "https://fcm.googleapis.com/fcm/send/a" }),
      row({ id: "b", endpoint: "https://fcm.googleapis.com/fcm/send/b" })
    ]);
    const result = await deliverPush(INPUT);
    expect(result).toEqual({ ok: true, sent: 2, revoked: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(stampPushSent).toHaveBeenCalledWith(["a", "b"]);
  });

  it("refuses without VAPID config, before reading any subscription", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    expect(await deliverPush(INPUT)).toEqual({ ok: false, reason: "vapid_unconfigured" });
    expect(listDeliverablePushSubscriptions).not.toHaveBeenCalled();
  });

  it("reports not_connected when the scope has no devices", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([]);
    expect(await deliverPush(INPUT)).toEqual({ ok: false, reason: "not_connected" });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("refuses below the tier bar without sending", async () => {
    vi.mocked(pushAllowedForBusiness).mockResolvedValue(false);
    expect(await deliverPush(INPUT)).toEqual({ ok: false, reason: "tier_blocked" });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("delivers anyway when the tier lookup itself fails", async () => {
    // Fails TOWARD delivering: an alert must never be lost to a transient
    // tier-read blip, which is the same posture deliverSlackAlert takes.
    vi.mocked(pushAllowedForBusiness).mockRejectedValue(new Error("db down"));
    expect(await deliverPush(INPUT)).toEqual({ ok: true, sent: 1, revoked: 0 });
  });

  it("skips the tier check entirely for the platform scope", async () => {
    // HQ admin devices belong to no tenant, so there is no tier to read.
    const result = await deliverPush({ ...INPUT, scope: { businessId: null } });
    expect(result).toEqual({ ok: true, sent: 1, revoked: 0 });
    expect(pushAllowedForBusiness).not.toHaveBeenCalled();
    // Platform scope is admin-only by construction; do not roster-filter it.
    expect(listEligiblePushUserIds).not.toHaveBeenCalled();
  });

  it.each([404, 410])("revokes a subscription the push service reports gone (%i)", async (code) => {
    vi.mocked(webpush.sendNotification).mockRejectedValue(pushError(code));
    const result = await deliverPush(INPUT);
    expect(result).toEqual({
      ok: false,
      reason: "all_expired",
      detail: "1 expired"
    });
    expect(revokePushSubscription).toHaveBeenCalledWith(
      "https://fcm.googleapis.com/fcm/send/one",
      "expired"
    );
  });

  /**
   * THE ONE THAT WOULD BE CATASTROPHIC.
   *
   * A 403 means the VAPID key does not match the subscription, which a
   * botched key rotation produces for EVERY device on the fleet at once.
   * Treating it as expiry would revoke every subscription we hold in a single
   * dispatch, and the only recovery would be asking every owner to
   * re-install. It is a transient config fault; the registrar re-subscribes
   * each device on its next dashboard load.
   */
  it("does NOT revoke on 403, which is a key mismatch and not an expiry", async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue(pushError(403));
    const result = await deliverPush(INPUT);
    expect(revokePushSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "send_failed", detail: "http_403" });
  });

  it.each([413, 429, 500, 503])("does not revoke on %i", async (code) => {
    vi.mocked(webpush.sendNotification).mockRejectedValue(pushError(code));
    await deliverPush(INPUT);
    expect(revokePushSubscription).not.toHaveBeenCalled();
  });

  it("lets one dead device not stop the others", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "dead", endpoint: "https://fcm.googleapis.com/fcm/send/dead" }),
      row({ id: "live", endpoint: "https://fcm.googleapis.com/fcm/send/live" })
    ]);
    vi.mocked(webpush.sendNotification)
      .mockRejectedValueOnce(pushError(410))
      .mockResolvedValueOnce({} as never);

    const result = await deliverPush(INPUT);
    expect(result).toEqual({ ok: true, sent: 1, revoked: 1 });
    expect(stampPushSent).toHaveBeenCalledWith(["live"]);
  });

  it("logs a refusal without throwing when the stored endpoint will not parse", async () => {
    // Only the HOST is logged (an endpoint is a bearer capability), and a row
    // whose endpoint predates the allowlist must not turn a log line into a
    // second failure on top of the one being reported.
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "bad", endpoint: "not-a-url" })
    ]);
    vi.mocked(webpush.sendNotification).mockRejectedValue(pushError(500));
    expect(await deliverPush(INPUT)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "http_500"
    });
  });

  it("reports send_failed on a non-WebPushError throw", async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue(new Error("socket hang up"));
    expect(await deliverPush(INPUT)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "socket hang up"
    });
  });

  it("reports send_failed on a thrown non-Error", async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue("string blew up");
    expect(await deliverPush(INPUT)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "string blew up"
    });
  });

  it("reports send_failed when the subscription read throws", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockRejectedValue(new Error("pg down"));
    expect(await deliverPush(INPUT)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "pg down"
    });
  });

  it("reports send_failed when the subscription read throws a non-Error", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockRejectedValue({ weird: true });
    expect(await deliverPush(INPUT)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "subscription_read_failed"
    });
  });

  it("still reports success when the revoke of a dead device fails", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "dead", endpoint: "https://fcm.googleapis.com/fcm/send/dead" }),
      row({ id: "live", endpoint: "https://fcm.googleapis.com/fcm/send/live" })
    ]);
    vi.mocked(webpush.sendNotification)
      .mockRejectedValueOnce(pushError(410))
      .mockResolvedValueOnce({} as never);
    vi.mocked(revokePushSubscription).mockRejectedValue(new Error("write failed"));

    expect(await deliverPush(INPUT)).toEqual({ ok: true, sent: 1, revoked: 1 });
  });

  it("still reports success when the last_sent_at stamp fails", async () => {
    // Bookkeeping must never turn a delivered push into a reported failure.
    vi.mocked(stampPushSent).mockRejectedValue(new Error("write failed"));
    expect(await deliverPush(INPUT)).toEqual({ ok: true, sent: 1, revoked: 0 });
  });

  it("passes the notification id through so a tap can be attributed", async () => {
    await deliverPush({ ...INPUT, notificationId: "n-1", tag: "contact:x" });
    const payload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1] as string);
    expect(payload.notificationId).toBe("n-1");
    expect(payload.tag).toBe("contact:x");
  });

  it("sends the subscription in the shape web-push expects", async () => {
    await deliverPush(INPUT);
    expect(vi.mocked(webpush.sendNotification).mock.calls[0][0]).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/one",
      keys: { p256dh: "key", auth: "auth" }
    });
  });

  it("reports send_failed, not all_expired, when nothing landed and nothing expired", async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue(pushError(500));
    const result = await deliverPush(INPUT);
    expect(result).toEqual({ ok: false, reason: "send_failed", detail: "http_500" });
  });

  it("sends only to roster devices and membership-revokes a leaked admin row", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "owner", endpoint: "https://fcm.googleapis.com/fcm/send/owner" }),
      row({
        id: "admin",
        user_id: "admin-1",
        endpoint: "https://fcm.googleapis.com/fcm/send/admin"
      })
    ]);
    const result = await deliverPush(INPUT);
    expect(result).toEqual({ ok: true, sent: 1, revoked: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webpush.sendNotification).mock.calls[0][0]).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/owner",
      keys: { p256dh: "key", auth: "auth" }
    });
    expect(revokePushSubscriptionsForUser).toHaveBeenCalledWith(BIZ, "admin-1");
    expect(stampPushSent).toHaveBeenCalledWith(["owner"]);
  });

  it("reports not_connected when every live row belongs to a non-member", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "admin-a", user_id: "admin-1", endpoint: "https://fcm.googleapis.com/fcm/send/admin-a" }),
      row({ id: "admin-b", user_id: "admin-1", endpoint: "https://fcm.googleapis.com/fcm/send/admin-b" })
    ]);
    expect(await deliverPush(INPUT)).toEqual({ ok: false, reason: "not_connected" });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    // Two devices, one user: revoke once, scoped to the business, not the endpoint.
    expect(revokePushSubscriptionsForUser).toHaveBeenCalledTimes(1);
    expect(revokePushSubscriptionsForUser).toHaveBeenCalledWith(BIZ, "admin-1");
  });

  it("still sends to the owner when revoking the leaked row fails", async () => {
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "owner", endpoint: "https://fcm.googleapis.com/fcm/send/owner" }),
      row({
        id: "admin",
        user_id: "admin-1",
        endpoint: "https://fcm.googleapis.com/fcm/send/admin"
      })
    ]);
    vi.mocked(revokePushSubscriptionsForUser).mockRejectedValue(new Error("write failed"));
    expect(await deliverPush(INPUT)).toEqual({ ok: true, sent: 1, revoked: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("fails open and sends to every row when eligibility cannot be resolved", async () => {
    // Without the owner's id we cannot tell their phone from the operator's.
    // Filtering strictly would revoke the owner. A blip must be noisy, not silent.
    vi.mocked(listEligiblePushUserIds).mockResolvedValue(null);
    vi.mocked(listDeliverablePushSubscriptions).mockResolvedValue([
      row({ id: "owner" }),
      row({ id: "admin", user_id: "admin-1", endpoint: "https://fcm.googleapis.com/fcm/send/admin" })
    ]);
    expect(await deliverPush(INPUT)).toEqual({ ok: true, sent: 2, revoked: 0 });
    expect(revokePushSubscriptionsForUser).not.toHaveBeenCalled();
  });
});
