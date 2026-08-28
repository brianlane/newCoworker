import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  listLivePushSubscriptions,
  repointPushSubscription,
  pushTargetState,
  listDeliverablePushSubscriptions,
  recordPushClick,
  revokePushSubscription,
  revokePushSubscriptionsForUser,
  stampPushSent,
  upsertPushSubscription
} from "@/lib/push/db";

type Call = [string, ...unknown[]];

/**
 * PostgREST-shaped recording double. Every builder method returns `this` and
 * appends to `calls`, so a test can assert the OPERATOR used, not just the
 * rows that came back. That distinction matters here: the NULL-scope filter
 * below returns the same fixture under a right and a wrong operator, so a
 * row-level assertion would pass either way.
 */
function makeDb(result: { data?: unknown; error?: { message: string } | null } = {}) {
  const calls: Call[] = [];
  const payloads: unknown[] = [];
  const builder: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return builder;
    };
  for (const method of ["select", "eq", "is", "gt", "in", "or", "order", "limit"]) {
    builder[method] = record(method);
  }
  for (const method of ["upsert", "update", "insert"]) {
    builder[method] = (payload: unknown, opts?: unknown) => {
      calls.push([method, payload, opts]);
      payloads.push(payload);
      return builder;
    };
  }
  // Terminal: awaiting the builder resolves to the PostgREST envelope.
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: result.data ?? null, error: result.error ?? null });

  const db = { from: vi.fn(() => builder) };
  return { db, calls, payloads, builder };
}

const BIZ = "11111111-1111-1111-1111-111111111111";
const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: "pub", auth: "auth" }
};

beforeEach(() => vi.clearAllMocks());

describe("push/db: upsertPushSubscription", () => {
  it("upserts on the scope+endpoint index and clears any revocation", async () => {
    const { db, payloads, calls } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await upsertPushSubscription({
      scope: { businessId: BIZ },
      userId: "user-1",
      subscription: SUB,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"
    });

    const payload = payloads[0] as Record<string, unknown>;
    expect(payload.business_id).toBe(BIZ);
    expect(payload.user_id).toBe("user-1");
    expect(payload.endpoint).toBe(SUB.endpoint);
    expect(payload.p256dh).toBe("pub");
    expect(payload.auth).toBe("auth");
    // Derived server-side from the header, never taken from the body.
    expect(payload.device_label).toBe("iPhone Safari");
    // A browser presenting a subscription is the strongest evidence it lives,
    // so this is how a device recovers from an expiry or membership revoke.
    expect(payload.revoked_at).toBeNull();
    expect(payload.revoked_reason).toBeNull();

    const upsert = calls.find((c) => c[0] === "upsert");
    expect(upsert?.[2]).toEqual({ onConflict: "business_id,endpoint" });
  });

  it("stores a null business_id for the platform scope", async () => {
    const { db, payloads } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await upsertPushSubscription({
      scope: { businessId: null },
      userId: "admin-1",
      subscription: SUB,
      userAgent: null
    });
    expect((payloads[0] as Record<string, unknown>).business_id).toBeNull();
  });

  it("throws with context on a write error", async () => {
    const { db } = makeDb({ error: { message: "duplicate" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      upsertPushSubscription({
        scope: { businessId: BIZ },
        userId: "u",
        subscription: SUB,
        userAgent: null
      })
    ).rejects.toThrow("upsertPushSubscription: duplicate");
  });
});

describe("push/db: listDeliverablePushSubscriptions", () => {
  it("filters to live, unexpired devices for a tenant scope", async () => {
    const { db, calls } = makeDb({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await listDeliverablePushSubscriptions({ businessId: BIZ });

    expect(calls).toContainEqual(["eq", "business_id", BIZ]);
    expect(calls).toContainEqual(["is", "revoked_at", null]);
    expect(calls.some((c) => c[0] === "gt" && c[1] === "last_seen_at")).toBe(true);
  });

  /**
   * `.eq("business_id", null)` serializes to `business_id=eq.null`, which
   * matches ZERO rows rather than erroring. An HQ admin would simply never
   * receive anything, and nothing anywhere would report a problem. Same class
   * as the neq/isdistinct trap in channel-liveness-read.
   */
  it("uses is.null for the platform scope, never eq", async () => {
    const { db, calls } = makeDb({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await listDeliverablePushSubscriptions({ businessId: null });

    expect(calls).toContainEqual(["is", "business_id", null]);
    expect(calls.some((c) => c[0] === "eq" && c[1] === "business_id")).toBe(false);
  });

  it("returns an empty array when PostgREST returns null data", async () => {
    const { db } = makeDb({ data: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listDeliverablePushSubscriptions({ businessId: BIZ })).toEqual([]);
  });

  it("throws with context on a read error", async () => {
    const { db } = makeDb({ error: { message: "boom" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listDeliverablePushSubscriptions({ businessId: BIZ })).rejects.toThrow(
      "listDeliverablePushSubscriptions: boom"
    );
  });
});

describe("push/db: revokePushSubscription", () => {
  it("scopes the revoke to the caller when a user id is supplied", async () => {
    const { db, calls, payloads } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await revokePushSubscription("https://fcm.googleapis.com/fcm/send/abc", "user", {
      userId: "user-1"
    });

    // The user id is part of the PREDICATE, not a check afterwards, so one
    // signed-in person can never revoke another's device by guessing an
    // endpoint.
    expect(calls).toContainEqual(["eq", "user_id", "user-1"]);
    expect((payloads[0] as Record<string, unknown>).revoked_reason).toBe("user");
  });

  it("omits the user predicate for the send path, where a 410 is authoritative", async () => {
    const { db, calls } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await revokePushSubscription("https://fcm.googleapis.com/fcm/send/abc", "expired");
    expect(calls.some((c) => c[0] === "eq" && c[1] === "user_id")).toBe(false);
  });

  it("throws with context on error", async () => {
    const { db } = makeDb({ error: { message: "nope" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(revokePushSubscription("e", "user")).rejects.toThrow(
      "revokePushSubscription: nope"
    );
  });
});

describe("push/db: revokePushSubscriptionsForUser", () => {
  it("revokes every device that person registered for the business", async () => {
    const { db, calls, payloads } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await revokePushSubscriptionsForUser(BIZ, "user-1");
    expect(calls).toContainEqual(["eq", "business_id", BIZ]);
    expect(calls).toContainEqual(["eq", "user_id", "user-1"]);
    expect((payloads[0] as Record<string, unknown>).revoked_reason).toBe("membership");
  });

  it("throws with context on error", async () => {
    const { db } = makeDb({ error: { message: "nope" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(revokePushSubscriptionsForUser(BIZ, "u")).rejects.toThrow(
      "revokePushSubscriptionsForUser: nope"
    );
  });
});

describe("push/db: pushTargetState", () => {
  it("reports connected when the business has a live device", async () => {
    const { db } = makeDb({ data: [{ id: "sub-1" }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await pushTargetState(BIZ)).toEqual({ connected: true });
  });

  it("reports not connected when the business has never subscribed one", async () => {
    const { db } = makeDb({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await pushTargetState(BIZ)).toEqual({ connected: false });
  });

  it("ignores revoked devices", async () => {
    const { db, calls } = makeDb({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await pushTargetState(BIZ);
    expect(calls).toContainEqual(["is", "revoked_at", null]);
  });

  /**
   * limit(1), not maybeSingle. The Slack leg this mirrors reads a
   * one-row-per-business table, but push_subscriptions is one row per DEVICE
   * and maybeSingle ERRORS on a second row. Copying that shape would make the
   * check throw for every business with two phones, the throw would be
   * swallowed by the fail-open catch, and this would sit at "connected: true"
   * forever with nothing to notice it by.
   */
  it("uses limit(1), so a business with two devices does not error", async () => {
    const { db, calls, builder } = makeDb({ data: [{ id: "a" }, { id: "b" }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await pushTargetState(BIZ)).toEqual({ connected: true });
    expect(calls).toContainEqual(["limit", 1]);
    expect(builder.maybeSingle).toBeUndefined();
  });

  /**
   * FAILS TOWARD CONNECTED, matching slackAlertTargetState. This value decides
   * whether the dispatcher writes NO push row at all versus an honest skip, so
   * a read blip must degrade to the noisy-but-honest side. Reporting "not
   * applicable" on a hiccup would erase the channel from a tenant who really
   * does have devices, and leave nothing behind to notice it by.
   */
  it("fails toward connected on a read error", async () => {
    const { db } = makeDb({ error: { message: "pg down" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await pushTargetState(BIZ)).toEqual({ connected: true });
  });

  it("fails toward connected when the client itself cannot be built", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no service key"));
    expect(await pushTargetState(BIZ)).toEqual({ connected: true });
  });
});

describe("push/db: listLivePushSubscriptions", () => {
  /**
   * Returns a LIST, not one row. A person who is both an owner and an HQ
   * admin, subscribed in the same browser, holds a tenant row AND a platform
   * row on the same endpoint. An unordered limit(1) picked between them
   * arbitrarily, which either dropped the receipt or filed a platform alert as
   * that tenant's liveness. The caller resolves the scope instead.
   */
  it("returns every live scope for an endpoint", async () => {
    const { db } = makeDb({
      data: [
        { id: "tenant", business_id: BIZ },
        { id: "platform", business_id: null }
      ]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const rows = await listLivePushSubscriptions("e");
    expect(rows.map((r) => r.business_id)).toEqual([BIZ, null]);
  });

  it("ignores revoked rows", async () => {
    const { db, calls } = makeDb({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await listLivePushSubscriptions("e");
    expect(calls).toContainEqual(["is", "revoked_at", null]);
  });

  it("returns an empty array when nothing matches", async () => {
    const { db } = makeDb({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listLivePushSubscriptions("e")).toEqual([]);
  });

  it("returns an empty array when PostgREST answers null", async () => {
    const { db } = makeDb({ data: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listLivePushSubscriptions("e")).toEqual([]);
  });

  it("throws with context on error", async () => {
    const { db } = makeDb({ error: { message: "boom" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listLivePushSubscriptions("e")).rejects.toThrow(
      "listLivePushSubscriptions: boom"
    );
  });
});

describe("push/db: repointPushSubscription", () => {
  /**
   * A rotated subscription must keep the scopes it already had. The service
   * worker cannot know them: guessing the platform scope 403s every tenant
   * device, so the device would stay on a dead endpoint until its owner next
   * opened the dashboard.
   */
  it("moves every scope the caller held onto the new endpoint", async () => {
    const { db, payloads, calls } = makeDb({
      data: [{ business_id: BIZ }, { business_id: null }]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const moved = await repointPushSubscription({
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
      userId: "user-1",
      subscription: SUB,
      userAgent: null
    });

    expect(moved).toBe(2);
    const upserted = payloads.filter((p) => (p as Record<string, unknown>).endpoint);
    expect(upserted.map((p) => (p as Record<string, unknown>).business_id)).toEqual([BIZ, null]);
    // The old endpoint is retired, scoped to the caller.
    expect(calls).toContainEqual(["eq", "user_id", "user-1"]);
  });

  /**
   * The old endpoint is a SELECTOR, not authentication. The session identifies
   * the caller and user_id is in the predicate, so holding a leaked endpoint
   * moves nothing.
   */
  it("scopes the lookup to the caller, so a leaked endpoint moves nothing", async () => {
    const { db, calls } = makeDb({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const moved = await repointPushSubscription({
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/someone-elses",
      userId: "attacker",
      subscription: SUB,
      userAgent: null
    });
    expect(moved).toBe(0);
    expect(calls).toContainEqual(["eq", "user_id", "attacker"]);
  });

  /**
   * THE SELF-INFLICTED OUTAGE. Safari does not populate
   * `event.oldSubscription`, so the worker falls back to the current
   * subscription; `subscribe()` with an unchanged key returns that SAME
   * subscription, and the POST arrives with both endpoints equal. Revoking
   * unconditionally stamped revoked_at on the row the upsert had just
   * written, killing a working device.
   */
  it("does not retire the endpoint when the rotation did not actually change it", async () => {
    const { db, calls } = makeDb({ data: [{ business_id: BIZ }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const moved = await repointPushSubscription({
      previousEndpoint: SUB.endpoint,
      userId: "user-1",
      subscription: SUB,
      userAgent: null
    });

    expect(moved).toBe(1);
    // The upsert refreshed the row; nothing revoked it.
    const revoked = calls.filter(
      (c) => c[0] === "update" && (c[1] as Record<string, unknown>)?.revoked_reason
    );
    expect(revoked).toHaveLength(0);
  });

  /**
   * A rotation usually RACES the send that discovered the death: the push
   * service 410s, the send path stamps revoked_reason='expired', and then
   * pushsubscriptionchange arrives. Requiring revoked_at to be null made that
   * ordering find nothing and drop the replacement endpoint, which is the
   * outage the handler exists to prevent.
   *
   * `user` and `membership` revocations stay excluded: those are decisions a
   * browser must never quietly undo.
   */
  it("recovers a row already retired as expired, but not one deliberately revoked", async () => {
    const { db, calls } = makeDb({ data: [{ business_id: BIZ }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await repointPushSubscription({
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
      userId: "user-1",
      subscription: SUB,
      userAgent: null
    });
    expect(calls).toContainEqual(["or", "revoked_at.is.null,revoked_reason.eq.expired"]);
    // Scoped to the SELECT phase (everything before the first upsert): the
    // revoke that follows legitimately uses is("revoked_at", null) of its own,
    // so an unscoped negative would always fail.
    const selectPhase = calls.slice(0, calls.findIndex((c) => c[0] === "upsert"));
    expect(selectPhase.some((c) => c[0] === "is" && c[1] === "revoked_at")).toBe(false);
  });

  it("moves nothing when PostgREST answers null rather than an empty array", async () => {
    const { db } = makeDb({ data: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(
      await repointPushSubscription({
        previousEndpoint: "e",
        userId: "u",
        subscription: SUB,
        userAgent: null
      })
    ).toBe(0);
  });

  it("throws with context on a read error", async () => {
    const { db } = makeDb({ error: { message: "boom" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      repointPushSubscription({
        previousEndpoint: "e",
        userId: "u",
        subscription: SUB,
        userAgent: null
      })
    ).rejects.toThrow("repointPushSubscription: boom");
  });
});

describe("push/db: recordPushClick", () => {
  it("writes a push-channel click with no link and no prefetch flag", async () => {
    const { db, payloads } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await recordPushClick({ businessId: BIZ, notificationId: "n-1" });

    const payload = payloads[0] as Record<string, unknown>;
    expect(payload.business_id).toBe(BIZ);
    expect(payload.channel).toBe("push");
    // A push tap has no sms_links row: there is no shortened URL in the chain.
    expect(payload.link_id).toBeNull();
    expect(payload.notification_id).toBe("n-1");
    /**
     * Pinned false as a statement of fact, not a default. The prefetch problem
     * exists because messaging apps and carrier scanners fetch every link on
     * delivery; no such actor can fire a notificationclick.
     */
    expect(payload.likely_prefetch).toBe(false);
  });

  it("writes a null notification id when the payload carried none", async () => {
    const { db, payloads } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await recordPushClick({ businessId: BIZ });
    expect((payloads[0] as Record<string, unknown>).notification_id).toBeNull();
  });

  it("throws with context on error", async () => {
    const { db } = makeDb({ error: { message: "constraint" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(recordPushClick({ businessId: BIZ })).rejects.toThrow(
      "recordPushClick: constraint"
    );
  });
});

describe("push/db: stampPushSent", () => {
  it("does nothing, and touches no client, for an empty list", async () => {
    await stampPushSent([]);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("stamps the delivered ids", async () => {
    const { db, calls } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await stampPushSent(["a", "b"]);
    expect(calls).toContainEqual(["in", "id", ["a", "b"]]);
  });

  it("throws with context on error", async () => {
    const { db } = makeDb({ error: { message: "nope" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(stampPushSent(["a"])).rejects.toThrow("stampPushSent: nope");
  });
});
