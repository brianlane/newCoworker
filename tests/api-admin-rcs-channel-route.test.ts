/**
 * POST /api/admin/rcs-channel — the operator toggle behind the admin
 * "Messaging channel (RCS)" card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/channel-settings", () => ({
  getChannelSettings: vi.fn(),
  upsertChannelSettings: vi.fn()
}));

vi.mock("@/lib/db/logs", () => ({
  insertCoworkerLog: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/admin/rcs-channel/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getChannelSettings, upsertChannelSettings } from "@/lib/db/channel-settings";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/rcs-channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/rcs-channel route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({} as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "enterprise" } as never);
    vi.mocked(getChannelSettings).mockResolvedValue({ rcsAgentId: null, rcsEnabled: false });
    vi.mocked(upsertChannelSettings).mockResolvedValue({
      rcsAgentId: "agent_1",
      rcsEnabled: true
    });
    vi.mocked(insertCoworkerLog).mockResolvedValue(undefined as never);
  });

  it("saves the settings, audit-logs, and reports tier eligibility", async () => {
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, rcsAgentId: "agent_1", rcsEnabled: true })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      businessId: BIZ_ID,
      rcsAgentId: "agent_1",
      rcsEnabled: true,
      tierAllows: true
    });
    expect(upsertChannelSettings).toHaveBeenCalledWith(BIZ_ID, {
      rcsAgentId: "agent_1",
      rcsEnabled: true
    });
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ_ID,
        log_payload: expect.objectContaining({
          action: "rcs_channel_updated",
          rcsEnabled: true,
          previous: { rcsAgentId: null, rcsEnabled: false }
        })
      })
    );
  });

  it("reports tierAllows false for a non-enterprise tenant (settings still saved)", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "standard" } as never);
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, rcsAgentId: "agent_1", rcsEnabled: true })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.tierAllows).toBe(false);
    expect(upsertChannelSettings).toHaveBeenCalled();
  });

  it("404s on an unknown business", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, rcsAgentId: null, rcsEnabled: false })
    );
    expect(res.status).toBe(404);
    expect(upsertChannelSettings).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with VALIDATION_ERROR", async () => {
    const res = await POST(makeRequest({ businessId: "not-a-uuid", rcsEnabled: true }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("continues (and warns) when the audit log insert fails", async () => {
    vi.mocked(insertCoworkerLog).mockRejectedValue(new Error("log down"));
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, rcsAgentId: "agent_1", rcsEnabled: true })
    );
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "rcs-channel: audit log insert failed",
      expect.objectContaining({ businessId: BIZ_ID })
    );
  });

  it("propagates auth failures through handleRouteError", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("nope"));
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, rcsAgentId: null, rcsEnabled: false })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(upsertChannelSettings).not.toHaveBeenCalled();
  });
});
