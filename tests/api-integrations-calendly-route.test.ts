/**
 * The Calendly connect endpoint, id-keyed since multi-connection support: a
 * business can link SEVERAL Calendly accounts (one row per account).
 *
 * The behaviors worth pinning:
 *  - POST verifies BEFORE saving, a rejected token stores NOTHING (unlike
 *    the old single-row route, the account identity decides which row a
 *    token lands on, so an unverifiable token has no home);
 *  - the same account's re-pasted token CONVERGES onto its row (created:
 *    false) instead of stacking a duplicate;
 *  - PATCH disable / DELETE tear down THAT connection's webhook
 *    subscription through its own id, never the primary's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/db/calendly-connections", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/calendly-connections")>(
    "@/lib/db/calendly-connections"
  );
  return {
    CalendlyConnectionValidationError: actual.CalendlyConnectionValidationError,
    deleteCalendlyConnection: vi.fn(),
    getCalendlyConnectionById: vi.fn(),
    listPublicCalendlyConnections: vi.fn(),
    saveCalendlyConnection: vi.fn(),
    setCalendlyConnectionActive: vi.fn()
  };
});
vi.mock("@/lib/calendly/client", () => ({ verifyCalendlyToken: vi.fn() }));
vi.mock("@/lib/calendly/webhook-subscriptions", () => ({
  teardownCalendlyWebhookSubscription: vi.fn()
}));

import { DELETE, GET, PATCH, POST } from "@/app/api/integrations/calendly/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  CalendlyConnectionValidationError,
  deleteCalendlyConnection,
  getCalendlyConnectionById,
  listPublicCalendlyConnections,
  saveCalendlyConnection,
  setCalendlyConnectionActive
} from "@/lib/db/calendly-connections";
import { verifyCalendlyToken } from "@/lib/calendly/client";
import { teardownCalendlyWebhookSubscription } from "@/lib/calendly/webhook-subscriptions";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const URI = "https://api.calendly.com/users/U1";

function jsonRequest(method: string, body: unknown): Request {
  return new Request("https://app.test/api/integrations/calendly", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "owner@kyp.test",
    isAdmin: false
  } as never);
});

describe("GET", () => {
  it("lists the business's connections (masked)", async () => {
    vi.mocked(listPublicCalendlyConnections).mockResolvedValue([
      { id: CONN_ID, has_token: true } as never
    ]);
    const res = await GET(
      new Request(`https://app.test/api/integrations/calendly?businessId=${BIZ}`)
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { connections: Array<{ id: string }> } };
    expect(json.data.connections).toHaveLength(1);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("400s without a businessId and 401s without a session", async () => {
    const bad = await GET(new Request("https://app.test/api/integrations/calendly"));
    expect(bad.status).toBe(400);
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const unauth = await GET(
      new Request(`https://app.test/api/integrations/calendly?businessId=${BIZ}`)
    );
    expect(unauth.status).toBe(401);
  });
});

describe("POST (verify first, then save)", () => {
  it("saves NOTHING when the token fails verification", async () => {
    vi.mocked(verifyCalendlyToken).mockResolvedValue({
      ok: false,
      reason: "invalid_token"
    });
    const res = await POST(jsonRequest("POST", { businessId: BIZ, accessToken: "bad" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data).toMatchObject({
      connection: null,
      verified: false,
      verifyError: "invalid_token"
    });
    expect(saveCalendlyConnection).not.toHaveBeenCalled();
  });

  it("saves with the VERIFIED identity and reports created", async () => {
    vi.mocked(verifyCalendlyToken).mockResolvedValue({
      ok: true,
      userUri: URI,
      name: "Liz",
      email: "liz@lizdev.test"
    });
    vi.mocked(saveCalendlyConnection).mockResolvedValue({
      connection: { id: CONN_ID } as never,
      created: true
    });
    const res = await POST(jsonRequest("POST", { businessId: BIZ, accessToken: "pat" }));
    expect(res.status).toBe(200);
    expect(saveCalendlyConnection).toHaveBeenCalledWith({
      businessId: BIZ,
      accessToken: "pat",
      userUri: URI,
      accountName: "Liz",
      accountEmail: "liz@lizdev.test"
    });
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data).toMatchObject({ created: true, verified: true });
  });

  it("maps validation errors to 400 and 401s without a session", async () => {
    vi.mocked(verifyCalendlyToken).mockResolvedValue({
      ok: true,
      userUri: URI,
      name: null,
      email: null
    });
    vi.mocked(saveCalendlyConnection).mockRejectedValue(
      new CalendlyConnectionValidationError("bad token shape")
    );
    const res = await POST(jsonRequest("POST", { businessId: BIZ, accessToken: "pat" }));
    expect(res.status).toBe(400);

    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const unauth = await POST(jsonRequest("POST", { businessId: BIZ, accessToken: "pat" }));
    expect(unauth.status).toBe(401);
  });
});

describe("PATCH", () => {
  it("disable tears down THAT connection's webhook first, then flips the row", async () => {
    vi.mocked(setCalendlyConnectionActive).mockResolvedValue({ id: CONN_ID } as never);
    const res = await PATCH(
      jsonRequest("PATCH", { businessId: BIZ, connectionId: CONN_ID, isActive: false })
    );
    expect(res.status).toBe(200);
    expect(teardownCalendlyWebhookSubscription).toHaveBeenCalledWith(BIZ, CONN_ID);
    expect(setCalendlyConnectionActive).toHaveBeenCalledWith(BIZ, CONN_ID, false);
  });

  it("re-enable skips teardown; a missing row 404s", async () => {
    vi.mocked(setCalendlyConnectionActive).mockResolvedValue({ id: CONN_ID } as never);
    await PATCH(jsonRequest("PATCH", { businessId: BIZ, connectionId: CONN_ID, isActive: true }));
    expect(teardownCalendlyWebhookSubscription).not.toHaveBeenCalled();

    vi.mocked(setCalendlyConnectionActive).mockResolvedValue(null);
    const missing = await PATCH(
      jsonRequest("PATCH", { businessId: BIZ, connectionId: CONN_ID, isActive: true })
    );
    expect(missing.status).toBe(404);
  });

  it("401s without a session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await PATCH(
      jsonRequest("PATCH", { businessId: BIZ, connectionId: CONN_ID, isActive: false })
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE", () => {
  it("tears down the webhook while the token still exists, then deletes the row", async () => {
    vi.mocked(getCalendlyConnectionById).mockResolvedValue({ id: CONN_ID } as never);
    const res = await DELETE(jsonRequest("DELETE", { businessId: BIZ, connectionId: CONN_ID }));
    expect(res.status).toBe(200);
    expect(teardownCalendlyWebhookSubscription).toHaveBeenCalledWith(BIZ, CONN_ID);
    expect(deleteCalendlyConnection).toHaveBeenCalledWith(BIZ, CONN_ID);
  });

  it("404s an unknown connection and 401s without a session", async () => {
    vi.mocked(getCalendlyConnectionById).mockResolvedValue(null);
    const missing = await DELETE(
      jsonRequest("DELETE", { businessId: BIZ, connectionId: CONN_ID })
    );
    expect(missing.status).toBe(404);
    expect(deleteCalendlyConnection).not.toHaveBeenCalled();

    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const unauth = await DELETE(
      jsonRequest("DELETE", { businessId: BIZ, connectionId: CONN_ID })
    );
    expect(unauth.status).toBe(401);
  });
});
