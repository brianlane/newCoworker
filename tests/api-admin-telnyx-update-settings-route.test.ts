import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/telnyx-routes", () => ({
  upsertBusinessTelnyxSettings: vi.fn()
}));

import { POST } from "@/app/api/admin/telnyx/update-settings/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { upsertBusinessTelnyxSettings } from "@/lib/db/telnyx-routes";

const BIZ = "11111111-1111-4111-8111-111111111111";

function request(body: unknown): Request {
  return new Request("http://test/api/admin/telnyx/update-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function makeBusiness() {
  return {
    id: BIZ,
    name: "Corp",
    owner_email: "o@o.com",
    tier: "starter",
    status: "online",
    created_at: "2026-01-01T00:00:00Z"
  };
}

describe("POST /api/admin/telnyx/update-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "a",
      email: "a@a.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(makeBusiness() as never);
    vi.mocked(upsertBusinessTelnyxSettings).mockResolvedValue({
      business_id: BIZ,
      telnyx_messaging_profile_id: null,
      telnyx_sms_from_e164: null,
      telnyx_connection_id: null,
      bridge_media_wss_origin: null,
      bridge_media_path: "/voice/stream",
      bridge_last_heartbeat_at: null,
      bridge_last_error_at: null,
      bridge_error_message: null,
      telnyx_tcr_brand_id: null,
      telnyx_tcr_campaign_id: null,
      forward_to_e164: "+16025551234",
      transfer_enabled: true,
      sms_fallback_enabled: true,
      updated_at: "2026-01-01T00:00:00Z"
    } as never);
  });

  it("normalizes forwardToE164 and forwards to DB helper", async () => {
    const res = await POST(
      request({ businessId: BIZ, forwardToE164: "+1 (602) 555-1234", transferEnabled: true })
    );
    expect(res.status).toBe(200);
    expect(upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        forwardToE164: "+16025551234",
        transferEnabled: true,
        smsFallbackEnabled: undefined
      })
    );
  });

  it("treats empty string forwardToE164 as null (clears field)", async () => {
    await POST(request({ businessId: BIZ, forwardToE164: "" }));
    expect(upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({ forwardToE164: null })
    );
  });

  it("treats explicit null forwardToE164 as null", async () => {
    await POST(request({ businessId: BIZ, forwardToE164: null }));
    expect(upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({ forwardToE164: null })
    );
  });

  it("leaves forwardToE164 undefined when the client omits it", async () => {
    await POST(request({ businessId: BIZ, transferEnabled: false }));
    const call = vi.mocked(upsertBusinessTelnyxSettings).mock.calls[0][0] as Record<string, unknown>;
    expect(call.forwardToE164).toBeUndefined();
    expect(call.transferEnabled).toBe(false);
  });

  it("returns 400 on a malformed forwardToE164", async () => {
    const res = await POST(request({ businessId: BIZ, forwardToE164: "not a number at all" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    const res = await POST(request({ businessId: BIZ }));
    expect(res.status).toBe(404);
  });

  it("accepts sms fallback toggle", async () => {
    await POST(request({ businessId: BIZ, smsFallbackEnabled: false }));
    expect(upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({ smsFallbackEnabled: false })
    );
  });
});
