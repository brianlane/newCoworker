import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Teams activity receiver.
 *
 * ONE URL for every tenant, unlike Telegram's per-connection path, because
 * the activity is SIGNED. So the assertions here are about what happens
 * around that signature: the tenant is read from the verified token rather
 * than the request, an unbound tenant is refused, and the status codes match
 * what Bot Framework does with them (it retries a 5xx and gives up on a 4xx).
 */

vi.mock("@/lib/db/coworker-connections", () => ({
  getCoworkerConnectionByWorkspaceForChannel: vi.fn()
}));
vi.mock("@/lib/teams/auth", () => ({ verifyTeamsToken: vi.fn() }));
vi.mock("@/lib/teams/inbound", () => ({ handleTeamsActivity: vi.fn() }));
vi.mock("@/lib/coworker-channels/kick", () => ({ kickCoworkerWorker: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => void) => fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/webhooks/teams/route";
import { getCoworkerConnectionByWorkspaceForChannel } from "@/lib/db/coworker-connections";
import { verifyTeamsToken } from "@/lib/teams/auth";
import { handleTeamsActivity } from "@/lib/teams/inbound";
import { kickCoworkerWorker } from "@/lib/coworker-channels/kick";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function req(body: unknown) {
  return new Request("https://app/api/webhooks/teams", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

const ACTIVITY = { type: "message", channelData: { tenant: { id: TENANT } } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyTeamsToken).mockResolvedValue({
    ok: true,
    claims: { tenantId: TENANT, audience: "app-id" }
  });
  vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockResolvedValue({
    business_id: BIZ,
    is_active: true
  } as never);
  vi.mocked(handleTeamsActivity).mockResolvedValue({ enqueued: true });
});

describe("authentication", () => {
  it("accepts a verified activity and queues it", async () => {
    const res = await POST(req(ACTIVITY));
    expect(res.status).toBe(200);
    expect(kickCoworkerWorker).toHaveBeenCalledWith("teams");
  });

  it("refuses an unverified activity with 401, and says nothing about why", async () => {
    // Telling an unauthenticated caller WHICH check they failed is a free
    // oracle, so every rejection answers identically.
    for (const reason of ["bad_signature", "unexpected_audience", "expired", "unknown_key"]) {
      vi.mocked(verifyTeamsToken).mockResolvedValue({ ok: false, reason });
      const res = await POST(req(ACTIVITY));
      expect(res.status, reason).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(handleTeamsActivity).not.toHaveBeenCalled();
  });

  it("answers 500 when OUR key fetch failed, so Microsoft redelivers", async () => {
    // A 401 here would look like a rejected activity and never come back,
    // silently dropping every message until someone noticed.
    vi.mocked(verifyTeamsToken).mockResolvedValue({ ok: false, reason: "jwks_unavailable" });
    expect((await POST(req(ACTIVITY))).status).toBe(500);
  });

  it("takes the tenant from the VERIFIED token, not from the body", async () => {
    vi.mocked(verifyTeamsToken).mockResolvedValue({
      ok: true,
      claims: { tenantId: "trusted-tenant", audience: "app-id" }
    });
    await POST(req({ ...ACTIVITY, channelData: { tenant: { id: "attacker-claimed" } } }));
    expect(getCoworkerConnectionByWorkspaceForChannel).toHaveBeenCalledWith(
      "teams",
      "trusted-tenant"
    );
  });

  it("falls back to the activity's tenant only when the token carries none", async () => {
    vi.mocked(verifyTeamsToken).mockResolvedValue({
      ok: true,
      claims: { tenantId: null, audience: "app-id" }
    });
    await POST(req(ACTIVITY));
    expect(getCoworkerConnectionByWorkspaceForChannel).toHaveBeenCalledWith("teams", TENANT);
  });
});

describe("tenants we do not serve", () => {
  it("acks an unbound tenant with 200 rather than inviting retries", async () => {
    // Our Azure registration is multi-tenant, so anyone can install the app.
    // A 4xx would be equally uninformative to them and would make Microsoft
    // retry a message we will never want.
    vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockResolvedValue(null);
    const res = await POST(req(ACTIVITY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "unbound_tenant" });
    expect(handleTeamsActivity).not.toHaveBeenCalled();
  });

  it("acks a paused connection", async () => {
    vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockResolvedValue({
      business_id: BIZ,
      is_active: false
    } as never);
    expect((await POST(req(ACTIVITY))).status).toBe(200);
    expect(handleTeamsActivity).not.toHaveBeenCalled();
  });

  it("acks an activity carrying no tenant at all", async () => {
    vi.mocked(verifyTeamsToken).mockResolvedValue({
      ok: true,
      claims: { tenantId: null, audience: "app-id" }
    });
    const res = await POST(req({ type: "message" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "no_tenant" });
  });

  it("answers 500 when the connection read fails", async () => {
    vi.mocked(getCoworkerConnectionByWorkspaceForChannel).mockRejectedValue(new Error("db down"));
    expect((await POST(req(ACTIVITY))).status).toBe(500);
  });
});

describe("body handling", () => {
  it("answers 413 for an oversized body", async () => {
    expect((await POST(req("x".repeat(300 * 1024)))).status).toBe(413);
  });

  it("acks an unparseable body rather than inviting a retry", async () => {
    const res = await POST(req("not json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "unparseable" });
  });

  it("answers 500 when the handler fails, because the message is unanswered", async () => {
    vi.mocked(handleTeamsActivity).mockRejectedValue(new Error("store down"));
    expect((await POST(req(ACTIVITY))).status).toBe(500);
  });

  it("kicks the worker only when something was queued", async () => {
    vi.mocked(handleTeamsActivity).mockResolvedValue({ enqueued: false, reason: "not_linked" });
    await POST(req(ACTIVITY));
    expect(kickCoworkerWorker).not.toHaveBeenCalled();
  });
});
