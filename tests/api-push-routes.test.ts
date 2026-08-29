import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/push/db", () => ({
  upsertPushSubscription: vi.fn(),
  revokePushSubscription: vi.fn(),
  listLivePushSubscriptions: vi.fn(),
  repointPushSubscription: vi.fn(),
  recordPushClick: vi.fn()
}));

vi.mock("@/lib/push/tier-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/push/tier-gate")>(
    "@/lib/push/tier-gate"
  );
  return { ...actual, pushAllowedForBusiness: vi.fn() };
});

vi.mock("@/lib/db/notifications", () => ({
  markNotificationRead: vi.fn(),
  notificationBusinessId: vi.fn()
}));

import { POST as subscribe } from "@/app/api/push/subscribe/route";
import { POST as unsubscribe } from "@/app/api/push/unsubscribe/route";
import { POST as receipt } from "@/app/api/push/receipt/route";
import { GET as vapidKey } from "@/app/api/push/vapid-key/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  listLivePushSubscriptions,
  repointPushSubscription,
  recordPushClick,
  revokePushSubscription,
  upsertPushSubscription
} from "@/lib/push/db";
import { pushAllowedForBusiness } from "@/lib/push/tier-gate";
import { markNotificationRead, notificationBusinessId } from "@/lib/db/notifications";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OTHER_BIZ = "22222222-2222-4222-8222-222222222222";
const NOTIF = "33333333-3333-4333-8333-333333333333";
const OWNER = { userId: "user-1", email: "owner@example.com", isAdmin: false };
const ADMIN = { userId: "admin-1", email: "admin@example.com", isAdmin: true };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const SUBSCRIPTION = { endpoint: ENDPOINT, keys: { p256dh: "pub", auth: "auth" } };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/push/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function json(res: Response) {
  return (await res.json()) as { ok: boolean; data?: unknown; error?: { message: string } };
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.VAPID_PUBLIC_KEY = "BPublicKey";
  process.env.VAPID_PRIVATE_KEY = "PrivateKey";
  process.env.VAPID_SUBJECT = "mailto:a@b.com";
  vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
  vi.mocked(pushAllowedForBusiness).mockResolvedValue(true);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("api/push/vapid-key", () => {
  it("serves the public key to anyone, since every subscriber gets it anyway", async () => {
    const res = await vapidKey();
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ publicKey: "BPublicKey" });
  });

  it("caches briefly so a rotation converges without a redeploy", async () => {
    expect((await vapidKey()).headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("answers 503 when unconfigured rather than minting undeliverable subscriptions", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    expect((await vapidKey()).status).toBe(503);
  });

  it("never returns the private key", async () => {
    expect(JSON.stringify(await json(await vapidKey()))).not.toContain("PrivateKey");
  });
});

describe("api/push/subscribe", () => {
  it("registers a device for a tenant scope", async () => {
    const res = await subscribe(
      post({ businessId: BIZ, subscription: SUBSCRIPTION }, { "user-agent": "UA/1.0" })
    );
    expect(res.status).toBe(200);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "view_dashboard");
    expect(upsertPushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { businessId: BIZ },
        userId: "user-1",
        // Read from the header, never the body: a caller must not choose the
        // device label we later show them.
        userAgent: "UA/1.0"
      })
    );
  });

  it("rejects an anonymous caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await subscribe(post({ businessId: BIZ, subscription: SUBSCRIPTION }))).status).toBe(
      401
    );
  });

  it("refuses a tenant below the tier bar", async () => {
    vi.mocked(pushAllowedForBusiness).mockResolvedValue(false);
    const res = await subscribe(post({ businessId: BIZ, subscription: SUBSCRIPTION }));
    expect(res.status).toBe(403);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });

  it("propagates a role refusal", async () => {
    vi.mocked(requireBusinessRole).mockRejectedValue(
      Object.assign(new Error("no"), { status: 403 })
    );
    expect((await subscribe(post({ businessId: BIZ, subscription: SUBSCRIPTION }))).status).toBe(
      403
    );
  });

  /**
   * THE SSRF GUARD, at the route boundary. The server later POSTs to this
   * value, so an endpoint outside the push-service allowlist would let a
   * signed-in owner aim us at an internal address and read the result back
   * through the delivery outcome.
   */
  it.each([
    ["an internal address", "https://169.254.169.254/latest/meta-data/"],
    ["a lookalike host", "https://fcm.googleapis.com.evil.test/send/x"],
    ["plaintext http", "http://fcm.googleapis.com/fcm/send/x"]
  ])("refuses %s", async (_name, endpoint) => {
    const res = await subscribe(
      post({ businessId: BIZ, subscription: { ...SUBSCRIPTION, endpoint } })
    );
    expect(res.status).toBe(400);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });

  describe("rotation (pushsubscriptionchange)", () => {
    /**
     * The worker cannot know which business the device was registered
     * against, and guessing the platform scope 403s every tenant device.
     * So it sends the old endpoint and the server moves whatever scopes the
     * CALLER already had, preserving them.
     */
    it("moves the caller's existing scopes without needing a businessId", async () => {
      vi.mocked(repointPushSubscription).mockResolvedValue(2 as never);
      const res = await subscribe(
        post({ previousEndpoint: "https://fcm.googleapis.com/fcm/send/old", subscription: SUBSCRIPTION })
      );
      expect(res.status).toBe(200);
      expect((await json(res)).data).toEqual({ subscribed: true, rotated: 2 });
      expect(repointPushSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1" })
      );
      // A rotation never CREATES a registration, so no scope check applies.
      expect(upsertPushSubscription).not.toHaveBeenCalled();
      expect(requireBusinessRole).not.toHaveBeenCalled();
    });

    it("still requires a session, so an endpoint alone rotates nothing", async () => {
      vi.mocked(getAuthUser).mockResolvedValue(null as never);
      const res = await subscribe(
        post({ previousEndpoint: "https://fcm.googleapis.com/fcm/send/old", subscription: SUBSCRIPTION })
      );
      expect(res.status).toBe(401);
      expect(repointPushSubscription).not.toHaveBeenCalled();
    });

    it("reports nothing moved when the caller owned no rows at that endpoint", async () => {
      vi.mocked(repointPushSubscription).mockResolvedValue(0 as never);
      const res = await subscribe(
        post({ previousEndpoint: "https://fcm.googleapis.com/fcm/send/someone-elses", subscription: SUBSCRIPTION })
      );
      expect((await json(res)).data).toEqual({ subscribed: false, rotated: 0 });
    });
  });

  it("refuses a plain registration that omits the scope entirely", async () => {
    // Only a rotation may leave businessId out; a first registration without
    // one has no scope to attach to and must not silently pick.
    const res = await subscribe(post({ subscription: SUBSCRIPTION }));
    expect(res.status).toBe(400);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });

  describe("platform scope", () => {
    it("lets an admin register for platform alerts", async () => {
      vi.mocked(getAuthUser).mockResolvedValue(ADMIN as never);
      const res = await subscribe(post({ businessId: null, subscription: SUBSCRIPTION }));
      expect(res.status).toBe(200);
      expect(upsertPushSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { businessId: null } })
      );
      // No tenant, so no tier and no role to check.
      expect(requireBusinessRole).not.toHaveBeenCalled();
      expect(pushAllowedForBusiness).not.toHaveBeenCalled();
    });

    it("refuses a non-admin claiming the platform scope", async () => {
      const res = await subscribe(post({ businessId: null, subscription: SUBSCRIPTION }));
      expect(res.status).toBe(403);
      expect(upsertPushSubscription).not.toHaveBeenCalled();
    });
  });
});

describe("api/push/unsubscribe", () => {
  it("revokes scoped to the caller, so a leaked endpoint cannot revoke someone else", async () => {
    const res = await unsubscribe(post({ endpoint: ENDPOINT }));
    expect(res.status).toBe(200);
    expect(revokePushSubscription).toHaveBeenCalledWith(ENDPOINT, "user", { userId: "user-1" });
  });

  it("rejects an anonymous caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await unsubscribe(post({ endpoint: ENDPOINT }))).status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    expect((await unsubscribe(post({}))).status).toBe(400);
  });
});

describe("api/push/receipt", () => {
  const tenantSub = { id: "s1", business_id: BIZ, user_id: "user-1", endpoint: ENDPOINT };
  const platformSub = { id: "s2", business_id: null, user_id: "user-1", endpoint: ENDPOINT };

  /**
   * No session by design: authentication is possession of the endpoint (a
   * capability URL only this browser and we hold). Requiring a session would
   * stop recording receipts for exactly the owner this check exists to
   * notice: the one who has not signed in lately.
   */
  it("records a tap with no session at all", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([tenantSub] as never);
    vi.mocked(notificationBusinessId).mockResolvedValue(BIZ);

    const res = await receipt(post({ endpoint: ENDPOINT, notificationId: NOTIF }));
    expect(res.status).toBe(200);
    expect(recordPushClick).toHaveBeenCalledWith({ businessId: BIZ, notificationId: NOTIF });
    expect(markNotificationRead).toHaveBeenCalledWith(NOTIF, BIZ, "owner");
  });

  it("records nothing for an unknown or revoked endpoint, without erroring", async () => {
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([] as never);
    const res = await receipt(post({ endpoint: ENDPOINT }));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ recorded: false });
    expect(recordPushClick).not.toHaveBeenCalled();
  });

  it("uses the single scope when no notification id was sent", async () => {
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([tenantSub] as never);
    await receipt(post({ endpoint: ENDPOINT }));
    expect(recordPushClick).toHaveBeenCalledWith({
      businessId: BIZ,
      notificationId: undefined
    });
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  /**
   * THE DUAL-SCOPE CASE. A person who is both an owner and an HQ admin,
   * subscribed in the same browser, has a tenant row and a platform row on the
   * SAME endpoint. Choosing between them arbitrarily would either drop the
   * receipt or file a PLATFORM alert as that tenant's liveness evidence, and
   * manufacturing liveness is the exact failure this check exists to prevent.
   */
  it("resolves the scope from the notification when one endpoint spans two", async () => {
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([
      platformSub,
      tenantSub
    ] as never);
    vi.mocked(notificationBusinessId).mockResolvedValue(BIZ);

    await receipt(post({ endpoint: ENDPOINT, notificationId: NOTIF }));
    expect(recordPushClick).toHaveBeenCalledWith({ businessId: BIZ, notificationId: NOTIF });
  });

  it("records nothing when a dual-scope tap carries no notification id", async () => {
    // Ambiguous, and a guess here is a fabricated liveness signal.
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([
      platformSub,
      tenantSub
    ] as never);
    const res = await receipt(post({ endpoint: ENDPOINT }));
    expect((await json(res)).data).toEqual({ recorded: false });
    expect(recordPushClick).not.toHaveBeenCalled();
  });

  it("refuses a notification belonging to a scope this device is not subscribed under", async () => {
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([tenantSub] as never);
    vi.mocked(notificationBusinessId).mockResolvedValue(OTHER_BIZ);
    const res = await receipt(post({ endpoint: ENDPOINT, notificationId: NOTIF }));
    expect((await json(res)).data).toEqual({ recorded: false });
    expect(recordPushClick).not.toHaveBeenCalled();
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it("records nothing for an HQ admin device, which is not a tenant's evidence", async () => {
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([platformSub] as never);
    vi.mocked(notificationBusinessId).mockResolvedValue(null);
    const res = await receipt(post({ endpoint: ENDPOINT, notificationId: NOTIF }));
    expect(res.status).toBe(200);
    expect(recordPushClick).not.toHaveBeenCalled();
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it("keeps the receipt when marking read fails", async () => {
    // The liveness signal is the valuable half and it already landed; failing
    // to clear an unread badge must not discard it.
    vi.mocked(listLivePushSubscriptions).mockResolvedValue([tenantSub] as never);
    vi.mocked(notificationBusinessId).mockResolvedValue(BIZ);
    vi.mocked(markNotificationRead).mockRejectedValue(new Error("pg down"));
    const res = await receipt(post({ endpoint: ENDPOINT, notificationId: NOTIF }));
    expect(res.status).toBe(200);
    expect(recordPushClick).toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    expect((await receipt(post({ notificationId: "not-a-uuid" }))).status).toBe(400);
  });
});
