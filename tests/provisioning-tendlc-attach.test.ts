import { describe, expect, it, vi, beforeEach } from "vitest";

const setStatusSpy = vi.fn();
vi.mock("@/lib/db/telnyx-routes", () => ({
  setBusinessMessagingCampaignStatus: (...args: unknown[]) => setStatusSpy(...args)
}));

const createServiceClientSpy = vi.fn(async () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: createServiceClientSpy
}));

import {
  attachBusinessDidToCampaign,
  MissingTendlcConfigError,
  readTendlcConfig
} from "@/lib/provisioning/tendlc-attach";
import { TendlcApiError } from "@/lib/telnyx/tendlc";

type MaybeMockClient = {
  getCampaign: ReturnType<typeof vi.fn>;
  createPhoneNumberCampaign: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<MaybeMockClient> = {}): MaybeMockClient {
  return {
    getCampaign: vi.fn().mockResolvedValue({ campaignId: "c-1", status: "ACTIVE" }),
    createPhoneNumberCampaign: vi.fn().mockResolvedValue({
      phoneNumber: "+15551234567",
      campaignId: "c-1"
    }),
    ...overrides
  };
}

const CONFIG = { apiKey: "k", brandId: "brand_xyz", campaignId: "c-1" };

beforeEach(() => {
  setStatusSpy.mockReset();
  setStatusSpy.mockResolvedValue(undefined);
});

describe("readTendlcConfig", () => {
  it("returns null when nothing is set (cold start)", () => {
    expect(readTendlcConfig({})).toBeNull();
  });

  it("treats apiKey-only as cold start (TELNYX_API_KEY is shared infra, always set in prod)", () => {
    // Bugbot caught this: requiring apiKey to be ABSENT for cold start
    // means every real deployment hits the partial-config throw branch
    // before 10DLC is rolled out. Gate cold-start on the 10DLC-specific
    // keys only.
    expect(readTendlcConfig({ TELNYX_API_KEY: "k" })).toBeNull();
  });

  it("returns the populated config when all three values are present", () => {
    expect(
      readTendlcConfig({
        TELNYX_API_KEY: "k",
        TELNYX_10DLC_BRAND_ID: "brand",
        TELNYX_10DLC_CAMPAIGN_ID: "camp"
      })
    ).toEqual({ apiKey: "k", brandId: "brand", campaignId: "camp" });
  });

  it("throws MissingTendlcConfigError when SOME 10DLC values are populated but others aren't", () => {
    // brandId set, campaignId missing → real misconfig (someone half-wired
    // the rollout); this should fail loudly so operators notice.
    expect(() =>
      readTendlcConfig({ TELNYX_API_KEY: "k", TELNYX_10DLC_BRAND_ID: "brand" })
    ).toThrow(MissingTendlcConfigError);
    // campaignId set, brandId missing → same.
    expect(() =>
      readTendlcConfig({ TELNYX_API_KEY: "k", TELNYX_10DLC_CAMPAIGN_ID: "c" })
    ).toThrow(MissingTendlcConfigError);
    // brandId + campaignId set, apiKey missing → loud throw so we never
    // try to instantiate a TendlcClient with an empty key.
    expect(() =>
      readTendlcConfig({ TELNYX_10DLC_BRAND_ID: "brand", TELNYX_10DLC_CAMPAIGN_ID: "c" })
    ).toThrow(MissingTendlcConfigError);
  });

  it("treats blank/whitespace as missing (defence vs `process.env.X ?? \"\"` pipelines)", () => {
    expect(() =>
      readTendlcConfig({
        TELNYX_API_KEY: "   ",
        TELNYX_10DLC_BRAND_ID: "brand",
        TELNYX_10DLC_CAMPAIGN_ID: "c"
      })
    ).toThrow(MissingTendlcConfigError);
  });

  it("MissingTendlcConfigError exposes which fields were missing", () => {
    try {
      readTendlcConfig({ TELNYX_API_KEY: "k", TELNYX_10DLC_BRAND_ID: "brand" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTendlcConfigError);
      expect((err as MissingTendlcConfigError).missing).toEqual(["campaignId"]);
    }
  });
});

describe("attachBusinessDidToCampaign", () => {
  it("registered: ACTIVE campaign + 200 attach → status=registered persisted with campaign id", async () => {
    const client = makeClient();
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome).toEqual({ kind: "registered", campaignId: "c-1" });
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        status: "registered",
        campaignId: "c-1",
        lastError: null
      }),
      undefined
    );
  });

  it("registered: 409 conflict on attach is treated as success (idempotent)", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi
        .fn()
        .mockRejectedValue(new TendlcApiError("/10dlc/phoneNumberCampaign", 409, "exists"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome).toEqual({ kind: "registered", campaignId: "c-1" });
  });

  it("pending: returns pending when 10dlc is not configured (cold start)", async () => {
    // Explicit cold start — clear every env var readTendlcConfig consults so
    // the "config: null" path actually reaches the no-config branch even when
    // the test runner inherits TELNYX_API_KEY from a real .env file.
    const saved = {
      apiKey: process.env.TELNYX_API_KEY,
      brand: process.env.TELNYX_10DLC_BRAND_ID,
      campaign: process.env.TELNYX_10DLC_CAMPAIGN_ID
    };
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_10DLC_BRAND_ID;
    delete process.env.TELNYX_10DLC_CAMPAIGN_ID;
    try {
      const outcome = await attachBusinessDidToCampaign({
        businessId: "biz",
        toE164: "+15551234567"
      });
      expect(outcome).toEqual({ kind: "pending", reason: "10dlc_not_configured" });
      expect(setStatusSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: "biz",
          status: "pending",
          lastError: "10dlc_not_configured"
        }),
        undefined
      );
    } finally {
      if (saved.apiKey !== undefined) process.env.TELNYX_API_KEY = saved.apiKey;
      if (saved.brand !== undefined) process.env.TELNYX_10DLC_BRAND_ID = saved.brand;
      if (saved.campaign !== undefined) process.env.TELNYX_10DLC_CAMPAIGN_ID = saved.campaign;
    }
  });

  it("pending: campaign status != ACTIVE → reason carries the actual status", async () => {
    const client = makeClient({
      getCampaign: vi.fn().mockResolvedValue({ campaignId: "c-1", status: "VERIFIED" })
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome).toEqual({ kind: "pending", reason: "campaign_status:VERIFIED" });
    expect(client.createPhoneNumberCampaign).not.toHaveBeenCalled();
  });

  it("pending: empty status string surfaces as 'unknown' so the banner has something to show", async () => {
    const client = makeClient({
      getCampaign: vi.fn().mockResolvedValue({ campaignId: "c-1", status: "" })
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome).toEqual({ kind: "pending", reason: "campaign_status:unknown" });
  });

  it("rejected: getCampaign 404 → rejected (campaign id is wrong/deleted, not transient)", async () => {
    const client = makeClient({
      getCampaign: vi
        .fn()
        .mockRejectedValue(new TendlcApiError("/10dlc/campaign/x", 404, "not found"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("rejected");
    expect((outcome as { reason: string }).reason).toMatch(/getCampaign_failed/);
  });

  it("error: getCampaign 5xx → transient error, NOT persisted to status", async () => {
    const client = makeClient({
      getCampaign: vi
        .fn()
        .mockRejectedValue(new TendlcApiError("/10dlc/campaign/x", 503, "down"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("error");
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it("error: getCampaign network failure → transient error", async () => {
    const client = makeClient({
      getCampaign: vi.fn().mockRejectedValue(new TypeError("ECONNRESET"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("error");
    expect((outcome as { reason: string }).reason).toMatch(/ECONNRESET/);
  });

  it("rejected: attach 4xx (non-409) → rejected, persisted with the body", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi
        .fn()
        .mockRejectedValue(new TendlcApiError("/10dlc/phoneNumberCampaign", 422, "brand_unverified"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("rejected");
    expect((outcome as { reason: string }).reason).toMatch(/brand_unverified/);
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
      undefined
    );
  });

  it("pending: attach 400 / code 10036 means campaign is still carrier-processing", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi.fn().mockRejectedValue(
        new TendlcApiError(
          "/10dlc/phoneNumberCampaign",
          400,
          '{"errors":[{"code":"10036","title":"Resource is being processed","detail":"Campaign c-1 is still pending and has not been approved yet"}]}'
        )
      )
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("pending");
    expect((outcome as { reason: string }).reason).toMatch(/attach_pending/);
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending" }),
      undefined
    );
  });

  it("pending: attach 400 / code 10036 also handles Telnyx's spaced JSON formatting", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi.fn().mockRejectedValue(
        new TendlcApiError(
          "/10dlc/phoneNumberCampaign",
          400,
          '{\n  "errors": [{\n    "code"\n      :\n    "10036",\n    "detail": "Resource is being processed"\n  }]\n}'
        )
      )
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("pending");
  });

  it("pending: attach 400 / code 10036 handles non-JSON bodies with whitespace", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi
        .fn()
        .mockRejectedValue(
          new TendlcApiError("/10dlc/phoneNumberCampaign", 400, 'error: "code" \n : \n "10036"')
        )
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("pending");
  });

  it("pending: attach 400 with pending-campaign text is treated as carrier-processing", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi
        .fn()
        .mockRejectedValue(
          new TendlcApiError("/10dlc/phoneNumberCampaign", 400, "Campaign c-1 is still pending")
        )
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("pending");
  });

  it("rejected: attach 400 without pending markers stays a hard validation rejection", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi
        .fn()
        .mockRejectedValue(new TendlcApiError("/10dlc/phoneNumberCampaign", 400, "invalid phone"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("rejected");
  });

  it.each(["null", '"10036"'])(
    "rejected: attach 400 valid JSON primitive %s is not mistaken for Telnyx code 10036",
    async (body) => {
      const client = makeClient({
        createPhoneNumberCampaign: vi
          .fn()
          .mockRejectedValue(new TendlcApiError("/10dlc/phoneNumberCampaign", 400, body))
      });
      const outcome = await attachBusinessDidToCampaign({
        businessId: "biz",
        toE164: "+15551234567",
        client: client as never,
        config: CONFIG
      });
      expect(outcome.kind).toBe("rejected");
    }
  );

  it("error: attach 5xx → transient error, no DB write", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi
        .fn()
        .mockRejectedValue(new TendlcApiError("/10dlc/phoneNumberCampaign", 503, "down"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("error");
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it("error: attach throws non-Telnyx error → transient", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi.fn().mockRejectedValue(new Error("network gone"))
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("error");
    expect((outcome as { reason: string }).reason).toMatch(/network gone/);
  });

  it("error: attach throws non-Error value → transient with stringified reason", async () => {
    const client = makeClient({
      createPhoneNumberCampaign: vi.fn().mockRejectedValue("rawString")
    });
    const outcome = await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG
    });
    expect(outcome.kind).toBe("error");
    expect((outcome as { reason: string }).reason).toMatch(/rawString/);
  });

  it("skipCampaignStatusCheck: bypasses the getCampaign poll", async () => {
    const client = makeClient();
    await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG,
      skipCampaignStatusCheck: true
    });
    expect(client.getCampaign).not.toHaveBeenCalled();
    expect(client.createPhoneNumberCampaign).toHaveBeenCalled();
  });

  it("respects an injected dbClient", async () => {
    const client = makeClient();
    const dbClient = { tag: "test-db" } as never;
    await attachBusinessDidToCampaign({
      businessId: "biz",
      toE164: "+15551234567",
      client: client as never,
      config: CONFIG,
      dbClient
    });
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.any(Object),
      dbClient
    );
  });

  it("falls back to readTendlcConfig+real TendlcClient when neither is injected (covers the default branches)", async () => {
    const fetchImpl = vi
      .fn()
      // First call: getCampaign — return ACTIVE.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ campaignId: "c-1", status: "ACTIVE" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      // Second call: createPhoneNumberCampaign — 200.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ phoneNumber: "+15551234567", campaignId: "c-1" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    process.env.TELNYX_API_KEY = "k";
    process.env.TELNYX_10DLC_BRAND_ID = "brand";
    process.env.TELNYX_10DLC_CAMPAIGN_ID = "c-1";
    try {
      const outcome = await attachBusinessDidToCampaign({
        businessId: "biz",
        toE164: "+15551234567"
      });
      expect(outcome.kind).toBe("registered");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.TELNYX_10DLC_BRAND_ID;
      delete process.env.TELNYX_10DLC_CAMPAIGN_ID;
    }
  });
});

