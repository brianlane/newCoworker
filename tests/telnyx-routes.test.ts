import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  E164_REGEX,
  getTelnyxVoiceRouteForBusiness,
  upsertTelnyxVoiceRoute,
  getBusinessTelnyxSettings,
  setForwardToE164,
  setBusinessMessagingCampaignStatus,
  listBusinessesPendingTendlcAttach,
  upsertBusinessTelnyxSettings
} from "@/lib/db/telnyx-routes";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
};

function chain(): Chain {
  const c: Chain = {
    select: vi.fn(() => c),
    upsert: vi.fn(() => c),
    insert: vi.fn(() => c),
    delete: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    in: vi.fn(() => c),
    or: vi.fn(() => c)
  };
  return c;
}

function makeDb(c: Chain) {
  return { from: vi.fn(() => c) };
}

const sampleRoute = {
  to_e164: "+15551234567",
  business_id: "biz",
  media_wss_origin: "wss://x.example/voice",
  media_path: "/voice/stream",
  created_at: "2026-01-01T00:00:00Z"
};

const sampleSettings = {
  business_id: "biz",
  telnyx_messaging_profile_id: "prof",
  telnyx_sms_from_e164: "+15551234567",
  telnyx_connection_id: "conn",
  bridge_media_wss_origin: "wss://x.example/voice",
  bridge_media_path: "/voice/stream",
  bridge_last_heartbeat_at: null,
  bridge_last_error_at: null,
  bridge_error_message: null,
  telnyx_tcr_brand_id: null,
  telnyx_tcr_campaign_id: null,
  telnyx_messaging_campaign_id: null,
  telnyx_messaging_campaign_status: "pending",
  telnyx_messaging_campaign_last_error: null,
  telnyx_messaging_campaign_attached_at: null,
  telnyx_messaging_campaign_last_attempt_at: null,
  forward_to_e164: null,
  transfer_enabled: true,
  sms_fallback_enabled: true,
  updated_at: "2026-01-01T00:00:00Z"
};

describe("telnyx-routes DB layer", () => {
  it("getTelnyxVoiceRouteForBusiness filters by business_id, orders, limits", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: sampleRoute, error: null });
    const db = makeDb(c);
    const r = await getTelnyxVoiceRouteForBusiness("biz", db as never);
    expect(r).toEqual(sampleRoute);
    expect(db.from).toHaveBeenCalledWith("telnyx_voice_routes");
    expect(c.eq).toHaveBeenCalledWith("business_id", "biz");
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(1);
  });

  it("getTelnyxVoiceRouteForBusiness returns null on no data, throws on error", async () => {
    const c1 = chain();
    c1.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getTelnyxVoiceRouteForBusiness("biz", makeDb(c1) as never)).resolves.toBeNull();

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: { message: "db" } });
    await expect(getTelnyxVoiceRouteForBusiness("biz", makeDb(c2) as never)).rejects.toThrow(/db/);
  });

  it("upsertTelnyxVoiceRoute sends onConflict to_e164 and defaults media_path", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: sampleRoute, error: null });
    const db = makeDb(c);
    const r = await upsertTelnyxVoiceRoute(
      { toE164: "+15551234567", businessId: "biz" },
      db as never
    );
    expect(r).toEqual(sampleRoute);
    expect(c.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        to_e164: "+15551234567",
        business_id: "biz",
        media_wss_origin: null,
        media_path: "/voice/stream"
      }),
      { onConflict: "to_e164" }
    );
  });

  it("upsertTelnyxVoiceRoute respects overrides and surfaces errors", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: sampleRoute, error: null });
    const db = makeDb(c);
    await upsertTelnyxVoiceRoute(
      {
        toE164: "+15551234567",
        businessId: "biz",
        mediaWssOrigin: "wss://x",
        mediaPath: "/alt"
      },
      db as never
    );
    expect(c.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ media_wss_origin: "wss://x", media_path: "/alt" }),
      { onConflict: "to_e164" }
    );

    const c2 = chain();
    c2.single.mockResolvedValue({ data: null, error: { message: "conflict" } });
    await expect(
      upsertTelnyxVoiceRoute(
        { toE164: "+1", businessId: "b" },
        makeDb(c2) as never
      )
    ).rejects.toThrow(/conflict/);
  });

  it("getBusinessTelnyxSettings returns row, null, or throws", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: sampleSettings, error: null });
    await expect(getBusinessTelnyxSettings("biz", makeDb(c) as never)).resolves.toEqual(
      sampleSettings
    );

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getBusinessTelnyxSettings("biz", makeDb(c2) as never)).resolves.toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "bad" } });
    await expect(getBusinessTelnyxSettings("biz", makeDb(c3) as never)).rejects.toThrow(/bad/);
  });

  it("upsertBusinessTelnyxSettings only writes provided fields", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: sampleSettings, error: null });
    const db = makeDb(c);
    await upsertBusinessTelnyxSettings(
      {
        businessId: "biz",
        telnyxSmsFromE164: "+15551234567",
        telnyxMessagingProfileId: "prof",
        telnyxConnectionId: "conn",
        bridgeMediaWssOrigin: "wss://x",
        bridgeMediaPath: "/voice/stream"
      },
      db as never
    );
    const [row, opts] = c.upsert.mock.calls[0];
    expect(row).toMatchObject({
      business_id: "biz",
      telnyx_sms_from_e164: "+15551234567",
      telnyx_messaging_profile_id: "prof",
      telnyx_connection_id: "conn",
      bridge_media_wss_origin: "wss://x",
      bridge_media_path: "/voice/stream"
    });
    expect(opts).toEqual({ onConflict: "business_id" });
  });

  it("upsertBusinessTelnyxSettings with only businessId writes just business_id + updated_at", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: sampleSettings, error: null });
    const db = makeDb(c);
    await upsertBusinessTelnyxSettings({ businessId: "biz" }, db as never);
    const [row] = c.upsert.mock.calls[0];
    const r = row as Record<string, unknown>;
    expect(r.business_id).toBe("biz");
    expect(r).not.toHaveProperty("telnyx_sms_from_e164");
    expect(r).not.toHaveProperty("bridge_media_wss_origin");
  });

  it("upsertBusinessTelnyxSettings surfaces errors", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      upsertBusinessTelnyxSettings({ businessId: "biz" }, makeDb(c) as never)
    ).rejects.toThrow(/boom/);
  });

  it("upsertBusinessTelnyxSettings writes each individual optional field in isolation", async () => {
    const variants: Array<[string, Record<string, unknown>, string]> = [
      ["profile only", { telnyxMessagingProfileId: "prof" }, "telnyx_messaging_profile_id"],
      ["from only", { telnyxSmsFromE164: "+15551234567" }, "telnyx_sms_from_e164"],
      ["connection only", { telnyxConnectionId: "conn" }, "telnyx_connection_id"],
      ["origin only", { bridgeMediaWssOrigin: "wss://x" }, "bridge_media_wss_origin"],
      ["path only", { bridgeMediaPath: "/alt" }, "bridge_media_path"],
      ["forward only", { forwardToE164: "+15551234567" }, "forward_to_e164"],
      ["transfer only", { transferEnabled: false }, "transfer_enabled"],
      ["sms fallback only", { smsFallbackEnabled: false }, "sms_fallback_enabled"]
    ];
    for (const [, patch, expectedKey] of variants) {
      const c = chain();
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      await upsertBusinessTelnyxSettings(
        { businessId: "biz", ...(patch as Record<string, unknown>) },
        makeDb(c) as never
      );
      const [row] = c.upsert.mock.calls[0];
      expect(row as Record<string, unknown>).toHaveProperty(expectedKey);
    }
  });

  it("upsertBusinessTelnyxSettings accepts explicit null values to clear fields", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: sampleSettings, error: null });
    await upsertBusinessTelnyxSettings(
      {
        businessId: "biz",
        telnyxMessagingProfileId: null,
        telnyxSmsFromE164: null,
        telnyxConnectionId: null,
        bridgeMediaWssOrigin: null,
        forwardToE164: null
      },
      makeDb(c) as never
    );
    const [row] = c.upsert.mock.calls[0];
    const r = row as Record<string, unknown>;
    expect(r.telnyx_messaging_profile_id).toBeNull();
    expect(r.telnyx_sms_from_e164).toBeNull();
    expect(r.telnyx_connection_id).toBeNull();
    expect(r.bridge_media_wss_origin).toBeNull();
    expect(r.forward_to_e164).toBeNull();
  });

  describe("fallback to createSupabaseServiceClient when no client is provided", () => {
    function routeChain() {
      const c = chain();
      c.maybeSingle.mockResolvedValue({ data: sampleRoute, error: null });
      c.single.mockResolvedValue({ data: sampleRoute, error: null });
      return c;
    }
    function settingsChain() {
      const c = chain();
      c.maybeSingle.mockResolvedValue({ data: sampleSettings, error: null });
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      return c;
    }
    it("getTelnyxVoiceRouteForBusiness uses the default service client", async () => {
      defaultClientSpy.mockReturnValueOnce(makeDb(routeChain()));
      await expect(getTelnyxVoiceRouteForBusiness("biz")).resolves.toEqual(sampleRoute);
    });

    it("upsertTelnyxVoiceRoute uses the default service client", async () => {
      defaultClientSpy.mockReturnValueOnce(makeDb(routeChain()));
      await expect(
        upsertTelnyxVoiceRoute({ toE164: "+1", businessId: "b" })
      ).resolves.toEqual(sampleRoute);
    });

    it("getBusinessTelnyxSettings uses the default service client", async () => {
      defaultClientSpy.mockReturnValueOnce(makeDb(settingsChain()));
      await expect(getBusinessTelnyxSettings("biz")).resolves.toEqual(sampleSettings);
    });

    it("upsertBusinessTelnyxSettings uses the default service client", async () => {
      defaultClientSpy.mockReturnValueOnce(makeDb(settingsChain()));
      await expect(upsertBusinessTelnyxSettings({ businessId: "biz" })).resolves.toEqual(
        sampleSettings
      );
    });

    it("setForwardToE164 uses the default service client when not provided", async () => {
      defaultClientSpy.mockReturnValueOnce(makeDb(settingsChain()));
      await expect(setForwardToE164("biz", "+15551234567")).resolves.toEqual(sampleSettings);
    });

    it("setBusinessMessagingCampaignStatus uses the default service client when not provided", async () => {
      defaultClientSpy.mockReturnValueOnce(makeDb(settingsChain()));
      await expect(
        setBusinessMessagingCampaignStatus({ businessId: "biz", status: "pending" })
      ).resolves.toEqual(sampleSettings);
    });

    it("listBusinessesPendingTendlcAttach uses the default service client when not provided", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({ data: [], error: null });
      defaultClientSpy.mockReturnValueOnce({ from: vi.fn(() => cs) });
      await expect(listBusinessesPendingTendlcAttach()).resolves.toEqual([]);
    });
  });

  describe("listBusinessesPendingTendlcAttach", () => {
    function makeTwoTableDb(settingsChainObj: Chain, routesChainObj: Chain) {
      const from = vi
        .fn()
        .mockImplementationOnce(() => settingsChainObj) // 1st call: business_telnyx_settings
        .mockImplementationOnce(() => routesChainObj); //  2nd call: telnyx_voice_routes
      return { from };
    }

    it("returns [] when no pending/rejected rows exist (skips the routes round-trip)", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({ data: [], error: null });
      const cr = chain();
      const db = makeTwoTableDb(cs, cr);
      await expect(
        listBusinessesPendingTendlcAttach({}, db as never)
      ).resolves.toEqual([]);
      // Telnyx-route query MUST NOT fire when there are no candidates.
      expect(db.from).toHaveBeenCalledTimes(1);
      expect(db.from).toHaveBeenCalledWith("business_telnyx_settings");
    });

    it("joins settings → most-recent route per business", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({
        data: [
          {
            business_id: "biz1",
            telnyx_messaging_campaign_status: "pending",
            telnyx_messaging_campaign_last_attempt_at: null
          },
          {
            business_id: "biz2",
            telnyx_messaging_campaign_status: "rejected",
            telnyx_messaging_campaign_last_attempt_at: "2026-05-05T00:00:00Z"
          }
        ],
        error: null
      });
      const cr = chain();
      cr.order.mockResolvedValue({
        data: [
          {
            business_id: "biz1",
            to_e164: "+15551111111",
            created_at: "2026-05-04T00:00:00Z"
          },
          // Older route for biz1 — must be ignored.
          {
            business_id: "biz1",
            to_e164: "+15550000000",
            created_at: "2026-05-03T00:00:00Z"
          },
          {
            business_id: "biz2",
            to_e164: "+15552222222",
            created_at: "2026-05-04T00:00:00Z"
          }
        ],
        error: null
      });
      const db = makeTwoTableDb(cs, cr);
      const result = await listBusinessesPendingTendlcAttach(
        { staleAfterSeconds: 60, limit: 10 },
        db as never
      );
      expect(result).toEqual([
        {
          business_id: "biz1",
          to_e164: "+15551111111",
          status: "pending",
          last_attempt_at: null
        },
        {
          business_id: "biz2",
          to_e164: "+15552222222",
          status: "rejected",
          last_attempt_at: "2026-05-05T00:00:00Z"
        }
      ]);
      // 1st query: filter on the two interesting statuses + stale-only.
      expect(cs.in).toHaveBeenCalledWith(
        "telnyx_messaging_campaign_status",
        ["pending", "rejected"]
      );
      expect(cs.or).toHaveBeenCalledWith(
        expect.stringMatching(/last_attempt_at\.is\.null,.+last_attempt_at\.lt\./)
      );
      expect(cr.in).toHaveBeenCalledWith("business_id", ["biz1", "biz2"]);
    });

    it("filters out businesses without any voice route (nothing to attach)", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({
        data: [
          {
            business_id: "biz1",
            telnyx_messaging_campaign_status: "pending",
            telnyx_messaging_campaign_last_attempt_at: null
          },
          {
            business_id: "biz_no_route",
            telnyx_messaging_campaign_status: "pending",
            telnyx_messaging_campaign_last_attempt_at: null
          }
        ],
        error: null
      });
      const cr = chain();
      cr.order.mockResolvedValue({
        data: [
          {
            business_id: "biz1",
            to_e164: "+15551111111",
            created_at: "2026-05-04T00:00:00Z"
          }
        ],
        error: null
      });
      const result = await listBusinessesPendingTendlcAttach(
        {},
        makeTwoTableDb(cs, cr) as never
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.business_id).toBe("biz1");
    });

    it("clamps caller-supplied limit and staleAfterSeconds to safe ranges", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({ data: [], error: null });
      const db = makeTwoTableDb(cs, chain());
      await listBusinessesPendingTendlcAttach(
        { limit: 9999, staleAfterSeconds: -1 },
        db as never
      );
      // Limit ≤ 100.
      expect(cs.limit).toHaveBeenCalledWith(100);
      // Negative stale → 0; second arg is the cutoff iso, captured via `.or()`.
      const orArg = (cs.or.mock.calls[0]?.[0] ?? "") as string;
      expect(orArg).toMatch(/last_attempt_at\.is\.null/);
    });

    it("clamps tiny limit values up to 1", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({ data: [], error: null });
      await listBusinessesPendingTendlcAttach(
        { limit: 0 },
        makeTwoTableDb(cs, chain()) as never
      );
      expect(cs.limit).toHaveBeenCalledWith(1);
    });

    it("surfaces settings-side query errors", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({ data: null, error: { message: "settings boom" } });
      await expect(
        listBusinessesPendingTendlcAttach({}, makeTwoTableDb(cs, chain()) as never)
      ).rejects.toThrow(/settings boom/);
    });

    it("surfaces routes-side query errors", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({
        data: [
          {
            business_id: "biz1",
            telnyx_messaging_campaign_status: "pending",
            telnyx_messaging_campaign_last_attempt_at: null
          }
        ],
        error: null
      });
      const cr = chain();
      cr.order.mockResolvedValue({ data: null, error: { message: "route boom" } });
      await expect(
        listBusinessesPendingTendlcAttach({}, makeTwoTableDb(cs, cr) as never)
      ).rejects.toThrow(/route boom/);
    });

    it("treats null routes-data as empty (no candidates filtered through)", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({
        data: [
          {
            business_id: "biz1",
            telnyx_messaging_campaign_status: "pending",
            telnyx_messaging_campaign_last_attempt_at: null
          }
        ],
        error: null
      });
      const cr = chain();
      cr.order.mockResolvedValue({ data: null, error: null });
      const result = await listBusinessesPendingTendlcAttach(
        {},
        makeTwoTableDb(cs, cr) as never
      );
      expect(result).toEqual([]);
    });

    it("treats null settings-data as empty", async () => {
      const cs = chain();
      cs.limit.mockResolvedValue({ data: null, error: null });
      const result = await listBusinessesPendingTendlcAttach(
        {},
        makeTwoTableDb(cs, chain()) as never
      );
      expect(result).toEqual([]);
    });
  });

  describe("setBusinessMessagingCampaignStatus", () => {
    it("registered: sets campaign id, attached_at, last_attempt_at, and clears last_error", async () => {
      const c = chain();
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      await setBusinessMessagingCampaignStatus(
        {
          businessId: "biz",
          status: "registered",
          campaignId: "campaign-123",
          // lastError is intentionally provided to confirm the registered
          // branch wins (clears to null) regardless of caller input.
          lastError: "should-be-cleared"
        },
        makeDb(c) as never
      );
      const [row] = c.upsert.mock.calls[0];
      const r = row as Record<string, unknown>;
      expect(r.telnyx_messaging_campaign_id).toBe("campaign-123");
      expect(r.telnyx_messaging_campaign_status).toBe("registered");
      expect(r.telnyx_messaging_campaign_attached_at).toBeTypeOf("string");
      expect(r.telnyx_messaging_campaign_last_error).toBeNull();
      expect(r.telnyx_messaging_campaign_last_attempt_at).toBeTypeOf("string");
    });

    it("rejected: persists last_error verbatim, does not set attached_at, does not touch campaign id when undefined", async () => {
      const c = chain();
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      await setBusinessMessagingCampaignStatus(
        { businessId: "biz", status: "rejected", lastError: "10dlc/422 brand_unverified" },
        makeDb(c) as never
      );
      const [row] = c.upsert.mock.calls[0];
      const r = row as Record<string, unknown>;
      expect(r.telnyx_messaging_campaign_status).toBe("rejected");
      expect(r.telnyx_messaging_campaign_last_error).toBe("10dlc/422 brand_unverified");
      expect(r).not.toHaveProperty("telnyx_messaging_campaign_attached_at");
      expect(r).not.toHaveProperty("telnyx_messaging_campaign_id");
    });

    it("pending: persists last_error so the dashboard banner can show why we're waiting", async () => {
      const c = chain();
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      await setBusinessMessagingCampaignStatus(
        { businessId: "biz", status: "pending", lastError: "campaign_status:VERIFIED" },
        makeDb(c) as never
      );
      const [row] = c.upsert.mock.calls[0];
      expect((row as Record<string, unknown>).telnyx_messaging_campaign_last_error).toBe(
        "campaign_status:VERIFIED"
      );
    });

    it("explicit campaignId=null clears any existing pairing", async () => {
      const c = chain();
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      await setBusinessMessagingCampaignStatus(
        { businessId: "biz", status: "unregistered", campaignId: null },
        makeDb(c) as never
      );
      const [row] = c.upsert.mock.calls[0];
      expect((row as Record<string, unknown>).telnyx_messaging_campaign_id).toBeNull();
    });

    it("surfaces underlying DB errors", async () => {
      const c = chain();
      c.single.mockResolvedValue({ data: null, error: { message: "fk constraint" } });
      await expect(
        setBusinessMessagingCampaignStatus(
          { businessId: "biz", status: "pending" },
          makeDb(c) as never
        )
      ).rejects.toThrow(/fk constraint/);
    });
  });

  describe("E164_REGEX", () => {
    it("accepts valid international E.164", () => {
      for (const p of ["+15551234567", "+442079460958", "+8613800138000"]) {
        expect(E164_REGEX.test(p)).toBe(true);
      }
    });
    it("rejects invalid inputs (missing +, leading 0, alpha, too short/long)", () => {
      for (const p of [
        "15551234567",
        "+05551234567",
        "+1abc4567890",
        "+123",
        "+1234567890123456",
        ""
      ]) {
        expect(E164_REGEX.test(p)).toBe(false);
      }
    });
  });

  describe("setForwardToE164", () => {
    it("upserts a trimmed, valid E.164 into forward_to_e164", async () => {
      const c = chain();
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      const db = makeDb(c);
      await setForwardToE164("biz", "  +15551234567  ", db as never);
      const [row] = c.upsert.mock.calls[0];
      expect(row as Record<string, unknown>).toMatchObject({
        business_id: "biz",
        forward_to_e164: "+15551234567"
      });
    });

    it("clears the column when given null", async () => {
      const c = chain();
      c.single.mockResolvedValue({ data: sampleSettings, error: null });
      await setForwardToE164("biz", null, makeDb(c) as never);
      const [row] = c.upsert.mock.calls[0];
      expect((row as Record<string, unknown>).forward_to_e164).toBeNull();
    });

    it("clears the column when given an empty/whitespace string", async () => {
      for (const blank of ["", "   "]) {
        const c = chain();
        c.single.mockResolvedValue({ data: sampleSettings, error: null });
        await setForwardToE164("biz", blank, makeDb(c) as never);
        const [row] = c.upsert.mock.calls[0];
        expect((row as Record<string, unknown>).forward_to_e164).toBeNull();
      }
    });

    it("rejects invalid E.164 before touching the DB", async () => {
      const c = chain();
      await expect(
        setForwardToE164("biz", "555-1234", makeDb(c) as never)
      ).rejects.toThrow(/invalid E\.164/);
      expect(c.upsert).not.toHaveBeenCalled();
    });
  });
});
