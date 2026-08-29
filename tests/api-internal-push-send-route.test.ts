import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/push/send", () => ({ deliverPush: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));

import { POST } from "@/app/api/internal/push-send/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { deliverPush } from "@/lib/push/send";
import { getBusiness } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";

function post(body: unknown): Request {
  return new Request("https://app.test/api/internal/push-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
    body: JSON.stringify(body)
  });
}

const VALID = { businessId: BIZ, title: "Alert", body: "Something happened", url: "/dashboard" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertCronAuth).mockReturnValue(true);
  vi.mocked(deliverPush).mockResolvedValue({ ok: true, sent: 2, revoked: 0 });
  vi.mocked(getBusiness).mockResolvedValue({ hipaa_mode: false } as never);
});

describe("api/internal/push-send", () => {
  it("refuses without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    expect((await POST(post(VALID))).status).toBe(403);
    expect(deliverPush).not.toHaveBeenCalled();
  });

  it("delivers to the scope and returns the count", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { ok: true, sent: 2, revoked: 0 } });
    expect(deliverPush).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { businessId: BIZ }, title: "Alert" })
    );
  });

  it("accepts the platform scope", async () => {
    await POST(post({ ...VALID, businessId: null }));
    expect(deliverPush).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { businessId: null } })
    );
  });

  it("defaults the tap target when the caller sends none", async () => {
    const { url: _drop, ...noUrl } = VALID;
    await POST(post(noUrl));
    expect(deliverPush).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard" }));
  });

  /**
   * "No device subscribed" is a policy skip the caller records as a skipped
   * row, not a transport failure. Returning it as a 5xx would make the Deno
   * mirror treat an ordinary un-subscribed tenant as an outage.
   */
  it("returns an ok:false skip as HTTP 200", async () => {
    vi.mocked(deliverPush).mockResolvedValue({ ok: false, reason: "not_connected" });
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { ok: false, reason: "not_connected" } });
  });

  /**
   * The Deno dispatcher cannot import notificationLink (it lives in src/lib
   * and an edge function cannot reach it), so it sends the alert's kind and
   * payload and this route resolves the destination. One implementation of
   * "where did this alert happen", shared with the Node dispatcher and the
   * dashboard's notification list, instead of a second one drifting in
   * another runtime.
   */
  it("resolves the tap target from kind when the caller sends no url", async () => {
    const { url: _drop, ...noUrl } = VALID;
    await POST(post({ ...noUrl, kind: "voice_capture" }));
    expect(deliverPush).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/dashboard/calls" })
    );
  });

  /**
   * A derived link can carry a patient identifier
   * (/dashboard/customers/%2B15551234567 IS the identifier) into a payload
   * bound for a third-party push vendor. The caller is supposed to withhold
   * kind/payload for a HIPAA tenant, but that class of mistake is a
   * reportable breach rather than a bug, so the decision is re-made here.
   */
  it("never derives a link for a HIPAA tenant", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ hipaa_mode: true } as never);
    const { url: _drop, ...noUrl } = VALID;
    await POST(post({ ...noUrl, kind: "voice_capture" }));
    expect(deliverPush).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard" }));
  });

  it("fails closed to the plain dashboard when the business cannot be read", async () => {
    // getBusiness swallows its errors and returns null; an unknown hipaa_mode
    // must read as "redact", never as "safe".
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const { url: _drop, ...noUrl } = VALID;
    await POST(post({ ...noUrl, kind: "voice_capture" }));
    expect(deliverPush).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard" }));
  });

  it("prefers an explicit url over the derived one", async () => {
    await POST(post({ ...VALID, url: "/dashboard/bookings", kind: "voice_capture" }));
    expect(deliverPush).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/dashboard/bookings" })
    );
  });

  it("falls back to the dashboard when it is given neither", async () => {
    const { url: _drop, ...noUrl } = VALID;
    await POST(post(noUrl));
    expect(deliverPush).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard" }));
  });

  it.each([
    ["a missing title", { ...VALID, title: "" }],
    ["a non-uuid businessId", { ...VALID, businessId: "nope" }],
    ["an over-long body", { ...VALID, body: "x".repeat(700) }],
    ["an over-long url", { ...VALID, url: `/${"x".repeat(600)}` }],
    ["a non-uuid notificationId", { ...VALID, notificationId: "nope" }]
  ])("rejects %s", async (_name, body) => {
    expect((await POST(post(body))).status).toBe(400);
    expect(deliverPush).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected delivery throw as a 500", async () => {
    vi.mocked(deliverPush).mockRejectedValue(new Error("boom"));
    expect((await POST(post(VALID))).status).toBe(500);
  });
});
