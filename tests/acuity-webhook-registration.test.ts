/**
 * Tests for dynamic Acuity webhook registration
 * (src/lib/acuity/webhook-registration.ts).
 *
 * Registration is best-effort by design: webhooks buy latency, not
 * capability, since the ~1/min poller already observes every change. So the
 * behaviors worth pinning are the ways it legitimately does NOT work, the
 * 25-per-account ceiling and an account whose credentials cannot use the
 * Webhooks API at all, because both must degrade to the card's
 * paste-this-URL fallback rather than failing a connect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
const recordSystemLogMock = vi.fn(async (_input: Record<string, unknown>) => {});
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (input: Record<string, unknown>) => recordSystemLogMock(input)
}));

const listMock = vi.fn();
const createMock = vi.fn();
const removeMock = vi.fn();
const persistMock = vi.fn();
vi.mock("@/lib/acuity/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/acuity/client")>(
    "@/lib/acuity/client"
  );
  return {
    ACUITY_WEBHOOK_EVENTS: actual.ACUITY_WEBHOOK_EVENTS,
    AcuityApiError: actual.AcuityApiError,
    listAcuityWebhooks: (...a: unknown[]) => listMock(...a),
    createAcuityWebhook: (...a: unknown[]) => createMock(...a),
    deleteAcuityWebhook: (...a: unknown[]) => removeMock(...a)
  };
});
vi.mock("@/lib/db/acuity-connections", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/acuity-connections")>(
    "@/lib/db/acuity-connections"
  );
  return {
    readWebhookRegistration: actual.readWebhookRegistration,
    setAcuityWebhookRegistration: (...a: unknown[]) => persistMock(...a)
  };
});

import { AcuityApiError, ACUITY_WEBHOOK_EVENTS } from "@/lib/acuity/client";
import {
  ACUITY_WEBHOOK_RECHECK_MS,
  acuityWebhookCallbackUrl,
  ensureAcuityWebhooks,
  recheckAcuityWebhooks,
  teardownAcuityWebhooks
} from "@/lib/acuity/webhook-registration";

const BIZ = "biz-1";
const TARGET = "https://app.example.com/api/webhooks/acuity?business=biz-1&token=tok";

function conn(registration: Record<string, unknown> = {}) {
  return {
    id: "ac-1",
    business_id: BIZ,
    user_id: "1",
    apiKey: "k",
    api_base_url: "https://acuityscheduling.com",
    webhook_verification_token: "tok",
    default_appointment_type_id: null,
    default_calendar_id: null,
    default_calendar_timezone: null,
    suppress_provider_emails: true,
    webhook_registration: registration,
    is_active: true,
    created_at: "",
    updated_at: ""
  } as never;
}

function deps(over: Record<string, unknown> = {}) {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (_c: unknown, event: string) => ({ id: `id-${event}`, event, target: TARGET })),
    remove: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn().mockResolvedValue(undefined),
    nowIso: "2026-08-04T12:00:00.000Z",
    ...over
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acuityWebhookCallbackUrl", () => {
  it("builds a tenant URL and tolerates a trailing slash on the origin", () => {
    expect(acuityWebhookCallbackUrl("https://app.example.com/", BIZ, "tok")).toBe(TARGET);
  });

  it("encodes the token", () => {
    expect(acuityWebhookCallbackUrl("https://a.co", BIZ, "a b&c")).toContain("token=a%20b%26c");
  });
});

describe("ensureAcuityWebhooks", () => {
  it("registers one webhook per consumed event and persists the ids", async () => {
    const d = deps();
    const res = await ensureAcuityWebhooks(conn(), TARGET, d);
    expect(res.status).toBe("registered");
    expect(res.ids).toHaveLength(ACUITY_WEBHOOK_EVENTS.length);
    expect(res.registeredAt).toBe("2026-08-04T12:00:00.000Z");
    expect((d as never as { persist: { mock: { calls: unknown[][] } } }).persist.mock.calls[0][1]).toMatchObject({
      status: "registered"
    });
  });

  it("reconciles by TARGET, not by stored id, so a reconnect is idempotent", async () => {
    // A reconnect or a half-finished earlier attempt can leave registrations
    // our stored ids know nothing about. Anything pointing at our own
    // callback is ours.
    const d = deps({
      list: vi.fn().mockResolvedValue([
        { id: "stale-1", event: "appointment.scheduled", target: TARGET },
        { id: "someone-else", event: "appointment.scheduled", target: "https://other/hook" }
      ])
    });
    await ensureAcuityWebhooks(conn(), TARGET, d);
    const removed = (d as never as { remove: { mock: { calls: unknown[][] } } }).remove.mock.calls;
    expect(removed).toHaveLength(1);
    expect(removed[0][1]).toBe("stale-1");
  });

  it("also clears registrations left at a PREVIOUS callback URL", async () => {
    // The origin can drift (a NEXT_PUBLIC_APP_URL change, a different host).
    // Hooks left at the old URL keep eating the 25-webhook ceiling while
    // delivering somewhere that no longer serves this tenant.
    const OLD = "https://old.example.com/api/webhooks/acuity?business=biz-1&token=tok";
    const d = deps({
      list: vi.fn().mockResolvedValue([
        { id: "at-old", event: "appointment.scheduled", target: OLD },
        { id: "at-new", event: "appointment.scheduled", target: TARGET },
        { id: "not-ours", event: "appointment.scheduled", target: "https://other/hook" },
        { id: "no-target", event: "appointment.scheduled", target: null }
      ])
    });
    await ensureAcuityWebhooks(
      conn({ ids: [], targetUrl: OLD, status: "registered" }),
      TARGET,
      d
    );
    const removed = (d as never as { remove: { mock: { calls: unknown[][] } } }).remove.mock.calls
      .map((c) => c[1])
      .sort();
    expect(removed).toEqual(["at-new", "at-old"]);
  });

  it("keeps going when a stale registration cannot be deleted", async () => {
    const d = deps({
      list: vi.fn().mockResolvedValue([{ id: "stale", event: "x", target: TARGET }]),
      remove: vi.fn().mockRejectedValue(new Error("gone"))
    });
    const res = await ensureAcuityWebhooks(conn(), TARGET, d);
    // A duplicate delivery is harmless: the cal: dedupe keys collapse it.
    expect(res.status).toBe("registered");
  });

  it("reports cap_reached on the 400 Acuity returns at 25 webhooks", async () => {
    const d = deps({
      create: vi.fn().mockRejectedValue(new AcuityApiError("request_failed", "too many", 400))
    });
    const res = await ensureAcuityWebhooks(conn(), TARGET, d);
    expect(res.status).toBe("cap_reached");
    expect(res.registeredAt).toBeNull();
  });

  it("reports unsupported when the Webhooks API refuses these credentials", async () => {
    const d = deps({
      create: vi.fn().mockRejectedValue(new AcuityApiError("auth_failed", "nope", 403))
    });
    const res = await ensureAcuityWebhooks(conn(), TARGET, d);
    expect(res.status).toBe("unsupported");
  });

  it("keeps ids it DID create when a later create fails, so teardown can still clean up", async () => {
    let calls = 0;
    const d = deps({
      create: vi.fn(async (_c: unknown, event: string) => {
        calls += 1;
        if (calls > 1) throw new AcuityApiError("request_failed", "boom", 400);
        return { id: `id-${event}`, event, target: TARGET };
      })
    });
    const res = await ensureAcuityWebhooks(conn(), TARGET, d);
    expect(res.ids).toHaveLength(1);
    expect(res.status).toBe("cap_reached");
  });

  it("does NOT claim a registration when every create came back without an id", async () => {
    // We have just deleted whatever pointed at this target, so recording
    // "registered" with zero ids would assert a working webhook for an
    // account that now has none, and the recheck would never revisit it.
    const d = deps({ create: vi.fn().mockResolvedValue(null) });
    const res = await ensureAcuityWebhooks(conn(), TARGET, d);
    expect(res).toMatchObject({ status: "unsupported", ids: [], registeredAt: null });
  });

  it("never throws when persisting the result fails", async () => {
    const d = deps({ persist: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(ensureAcuityWebhooks(conn(), TARGET, d)).resolves.toMatchObject({
      status: "registered"
    });
  });

  it("never throws when the listing itself fails", async () => {
    const d = deps({ list: vi.fn().mockRejectedValue(new Error("down")) });
    await expect(ensureAcuityWebhooks(conn(), TARGET, d)).resolves.toMatchObject({
      status: "unsupported"
    });
  });
});

  it("never DEMOTES a previously working registration on a transient failure", async () => {
    // The recheck only revisits `registered` accounts, so persisting
    // `unsupported` over a working record would freeze one blip into a
    // permanently dead registration nothing ever re-examines.
    const d = deps({ list: vi.fn().mockRejectedValue(new Error("acuity down")) });
    const res = await ensureAcuityWebhooks(
      conn({
        ids: ["kept-1"],
        targetUrl: TARGET,
        registeredAt: "2026-08-01T00:00:00.000Z",
        status: "registered"
      }),
      TARGET,
      d
    );
    expect(res).toMatchObject({
      status: "registered",
      ids: ["kept-1"],
      // Stale on purpose: the next recheck retries the reconcile promptly.
      registeredAt: "2026-08-01T00:00:00.000Z"
    });
    expect(
      (d as never as { persist: { mock: { calls: unknown[][] } } }).persist.mock.calls[0][1]
    ).toMatchObject({ status: "registered" });
  });

  it("merges ids a failed attempt DID create, so teardown can remove them", async () => {
    // deletes-succeeded-then-create-failed: the partial creations must not
    // be orphaned from our stored ids.
    let calls = 0;
    const d = deps({
      create: vi.fn(async (_c: unknown, event: string) => {
        calls += 1;
        if (calls > 1) throw new AcuityApiError("request_failed", "boom", 500);
        return { id: `new-${event}`, event, target: TARGET };
      })
    });
    const res = await ensureAcuityWebhooks(
      conn({ ids: ["old-1"], targetUrl: TARGET, registeredAt: "2026-08-01T00:00:00.000Z", status: "registered" }),
      TARGET,
      d
    );
    expect(res.ids.sort()).toEqual(["new-appointment.scheduled", "old-1"]);
  });

  it("still records a first-connect failure honestly", async () => {
    // No prior registration to protect: the degraded status is the truth
    // and is what makes the card show the paste-this-URL fallback.
    const d = deps({ create: vi.fn().mockRejectedValue(new AcuityApiError("auth_failed", "no", 403)) });
    const res = await ensureAcuityWebhooks(conn(), TARGET, d);
    expect(res.status).toBe("unsupported");
  });

describe("teardownAcuityWebhooks", () => {
  it("removes the ids we stored", async () => {
    const d = deps();
    await teardownAcuityWebhooks(conn({ ids: ["a", "b"], status: "registered" }), null, d);
    const removed = (d as never as { remove: { mock: { calls: unknown[][] } } }).remove.mock.calls;
    expect(removed.map((c) => c[1])).toEqual(["a", "b"]);
  });

  it("keeps going when one delete fails", async () => {
    const d = deps({ remove: vi.fn().mockRejectedValue(new Error("gone")) });
    await expect(
      teardownAcuityWebhooks(conn({ ids: ["a", "b"], status: "registered" }), null, d)
    ).resolves.toBeUndefined();
  });

  it("also removes live hooks the DB never learned about", async () => {
    // ensureAcuityWebhooks swallows a persistence failure, so the database
    // can hold the PREVIOUS ids while Acuity holds the new set. Deleting
    // only what we stored would orphan those, and they keep eating the
    // account's 25-webhook ceiling with no way for the owner to find them.
    const d = deps({
      list: vi.fn().mockResolvedValue([
        { id: "orphan", event: "appointment.scheduled", target: TARGET },
        { id: "not-ours", event: "appointment.scheduled", target: "https://other/hook" }
      ])
    });
    await teardownAcuityWebhooks(conn({ ids: ["stored"], status: "registered" }), TARGET, d);
    const removed = (d as never as { remove: { mock: { calls: unknown[][] } } }).remove.mock.calls
      .map((c) => c[1])
      .sort();
    expect(removed).toEqual(["orphan", "stored"]);
  });

  it("clears hooks at BOTH the caller's target and the stored previous one", async () => {
    const OLD = "https://old.example.com/api/webhooks/acuity?business=biz-1&token=tok";
    const d = deps({
      list: vi.fn().mockResolvedValue([
        { id: "at-old", event: "e", target: OLD },
        { id: "at-new", event: "e", target: TARGET }
      ])
    });
    await teardownAcuityWebhooks(
      conn({ ids: [], targetUrl: OLD, status: "registered" }),
      TARGET,
      d
    );
    const removed = (d as never as { remove: { mock: { calls: unknown[][] } } }).remove.mock.calls
      .map((c) => c[1])
      .sort();
    expect(removed).toEqual(["at-new", "at-old"]);
  });

  it("falls back to the stored target when the caller has none", async () => {
    const d = deps({
      list: vi.fn().mockResolvedValue([{ id: "orphan", event: "e", target: TARGET }])
    });
    await teardownAcuityWebhooks(
      conn({ ids: [], targetUrl: TARGET, status: "registered" }),
      null,
      d
    );
    expect(
      (d as never as { remove: { mock: { calls: unknown[][] } } }).remove.mock.calls[0][1]
    ).toBe("orphan");
  });

  it("still removes the stored ids when the listing fails", async () => {
    const d = deps({ list: vi.fn().mockRejectedValue(new Error("down")) });
    await teardownAcuityWebhooks(conn({ ids: ["stored"], status: "registered" }), TARGET, d);
    expect(
      (d as never as { remove: { mock: { calls: unknown[][] } } }).remove.mock.calls[0][1]
    ).toBe("stored");
  });

  it("does nothing when nothing was registered", async () => {
    const d = deps();
    await teardownAcuityWebhooks(conn(), null, d);
    expect((d as never as { remove: { mock: { calls: unknown[] } } }).remove.mock.calls).toHaveLength(0);
  });
});

describe("recheckAcuityWebhooks", () => {
  const NOW = Date.parse("2026-08-10T12:00:00.000Z");

  it("re-registers a stale registration, because Acuity disables silently", async () => {
    const d = deps();
    const res = await recheckAcuityWebhooks(
      conn({
        ids: ["a"],
        targetUrl: TARGET,
        registeredAt: "2026-08-01T12:00:00.000Z",
        status: "registered"
      }),
      TARGET,
      NOW,
      d
    );
    expect(res?.status).toBe("registered");
    expect(recordSystemLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "acuity_webhook_rechecked" })
    );
  });

  it("does nothing when the registration is fresh", async () => {
    const d = deps();
    const res = await recheckAcuityWebhooks(
      conn({
        ids: ["a"],
        targetUrl: TARGET,
        registeredAt: new Date(NOW - ACUITY_WEBHOOK_RECHECK_MS / 2).toISOString(),
        status: "registered"
      }),
      TARGET,
      NOW,
      d
    );
    expect(res).toBeNull();
    expect((d as never as { list: { mock: { calls: unknown[] } } }).list.mock.calls).toHaveLength(0);
  });

  it("re-registers when the callback URL changed", async () => {
    const d = deps();
    const res = await recheckAcuityWebhooks(
      conn({
        ids: ["a"],
        targetUrl: "https://old/hook",
        registeredAt: new Date(NOW).toISOString(),
        status: "registered"
      }),
      TARGET,
      NOW,
      d
    );
    expect(res?.status).toBe("registered");
  });

  it("does NOT retry an account that already said no", async () => {
    // Retrying a cap_reached or unsupported account on every dashboard load
    // would burn the shared per-IP budget to get the same answer.
    for (const status of ["cap_reached", "unsupported"]) {
      const d = deps();
      const res = await recheckAcuityWebhooks(
        conn({ ids: [], targetUrl: TARGET, registeredAt: null, status }),
        TARGET,
        NOW,
        d
      );
      expect(res).toBeNull();
    }
  });
});

describe("default wiring", () => {
  it("uses its own transports when no deps are injected", async () => {
    listMock.mockResolvedValue([{ id: "stale", event: "x", target: TARGET }]);
    createMock.mockResolvedValue({ id: "new", event: "e", target: TARGET });
    removeMock.mockResolvedValue(undefined);
    persistMock.mockResolvedValue(undefined);
    const res = await ensureAcuityWebhooks(conn(), TARGET);
    expect(listMock).toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalled();
    expect(createMock).toHaveBeenCalled();
    expect(persistMock).toHaveBeenCalled();
    expect(res.status).toBe("registered");
    expect(res.registeredAt).toBeTruthy();
  });

  it("tears down with its own transport too", async () => {
    removeMock.mockResolvedValue(undefined);
    listMock.mockResolvedValue([]);
    await teardownAcuityWebhooks(conn({ ids: ["z"], status: "registered" }), null);
    expect(removeMock).toHaveBeenCalled();
  });

  it("stamps the recheck from the supplied clock", async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: "n", event: "e", target: TARGET });
    persistMock.mockResolvedValue(undefined);
    const NOW = Date.parse("2026-08-10T12:00:00.000Z");
    const res = await recheckAcuityWebhooks(
      conn({
        ids: ["a"],
        targetUrl: TARGET,
        registeredAt: "2026-08-01T12:00:00.000Z",
        status: "registered"
      }),
      TARGET,
      NOW
    );
    expect(res?.registeredAt).toBe(new Date(NOW).toISOString());
  });
});
