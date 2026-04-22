import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}))
}));

const mockedRoutes = vi.hoisted(() => ({
  upsertTelnyxVoiceRoute: vi.fn(),
  upsertBusinessTelnyxSettings: vi.fn(),
  getBusinessTelnyxSettings: vi.fn()
}));
vi.mock("@/lib/db/telnyx-routes", () => mockedRoutes);

import {
  normalizeE164,
  assignExistingDidToBusiness,
  orderAndAssignDidForBusiness,
  OrderAndAssignError
} from "@/lib/telnyx/assign-did";
import type { TelnyxNumbersClient } from "@/lib/telnyx/numbers";

const sampleRoute = {
  to_e164: "+15551234567",
  business_id: "biz",
  media_wss_origin: "wss://x",
  media_path: "/voice/stream",
  created_at: "2026-01-01T00:00:00Z"
};

const sampleSettings = {
  business_id: "biz",
  telnyx_messaging_profile_id: null,
  telnyx_sms_from_e164: "+15551234567",
  telnyx_connection_id: null,
  bridge_media_wss_origin: "wss://x",
  bridge_media_path: "/voice/stream",
  bridge_last_heartbeat_at: null,
  bridge_last_error_at: null,
  bridge_error_message: null,
  telnyx_tcr_brand_id: null,
  telnyx_tcr_campaign_id: null,
  forward_to_e164: null,
  transfer_enabled: true,
  sms_fallback_enabled: true,
  updated_at: "2026-01-01T00:00:00Z"
};

function makeTelnyxMock(overrides: Partial<TelnyxNumbersClient> = {}): TelnyxNumbersClient {
  const base = {
    searchAvailable: vi.fn().mockResolvedValue([{ phone_number: "+15551234567" }]),
    orderNumbers: vi
      .fn()
      .mockResolvedValue({ id: "ord_1", status: "pending", phone_numbers: [{ phone_number: "+15551234567" }] }),
    getNumberOrder: vi
      .fn()
      .mockResolvedValue({ id: "ord_1", status: "success", phone_numbers: [{ phone_number: "+15551234567" }] }),
    waitForNumberOrder: vi
      .fn()
      .mockResolvedValue({
        id: "ord_1",
        status: "success",
        phone_numbers: [{ phone_number: "+15551234567" }]
      }),
    updatePhoneNumber: vi.fn().mockResolvedValue({ id: "pn_1", phone_number: "+15551234567" })
  };
  return { ...base, ...overrides } as unknown as TelnyxNumbersClient;
}

describe("normalizeE164", () => {
  it("accepts plain E.164", () => {
    expect(normalizeE164("+15551234567")).toBe("+15551234567");
  });
  it("strips formatting characters", () => {
    expect(normalizeE164(" +1 (555) 123-4567 ")).toBe("+15551234567");
  });
  it("prepends + when missing", () => {
    expect(normalizeE164("15551234567")).toBe("+15551234567");
  });
  it("rejects too-short numbers", () => {
    expect(() => normalizeE164("+123")).toThrow(/invalid E.164/);
  });
  it("rejects too-long numbers", () => {
    expect(() => normalizeE164("+1234567890123456")).toThrow(/invalid E.164/);
  });
  it("rejects non-digit leftovers", () => {
    expect(() => normalizeE164("++++")).toThrow(/invalid E.164/);
  });
  it("handles a null-ish input defensively", () => {
    expect(() => normalizeE164("" as string)).toThrow(/invalid E.164/);
  });
  it("handles undefined/null input via `?? \"\"` fallback", () => {
    expect(() => normalizeE164(undefined as unknown as string)).toThrow(/invalid E.164/);
    expect(() => normalizeE164(null as unknown as string)).toThrow(/invalid E.164/);
  });
});

describe("assignExistingDidToBusiness", () => {
  beforeEach(() => {
    mockedRoutes.upsertTelnyxVoiceRoute.mockReset();
    mockedRoutes.upsertBusinessTelnyxSettings.mockReset();
    mockedRoutes.getBusinessTelnyxSettings.mockReset();
    mockedRoutes.upsertTelnyxVoiceRoute.mockResolvedValue(sampleRoute);
    mockedRoutes.upsertBusinessTelnyxSettings.mockResolvedValue(sampleSettings);
    mockedRoutes.getBusinessTelnyxSettings.mockResolvedValue(null);
  });

  it("upserts settings + route and returns both, without Telnyx when associate=false", async () => {
    const result = await assignExistingDidToBusiness({
      businessId: "biz",
      toE164: "+1 (555) 123-4567",
      platformDefaults: {
        connectionId: "conn",
        messagingProfileId: "prof",
        bridgeMediaWssOrigin: "wss://x"
      }
    });
    expect(result.route).toEqual(sampleRoute);
    expect(result.settings).toEqual(sampleSettings);
    expect(mockedRoutes.upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        telnyxSmsFromE164: "+15551234567",
        telnyxConnectionId: "conn",
        telnyxMessagingProfileId: "prof",
        bridgeMediaWssOrigin: "wss://x"
      }),
      expect.anything()
    );
    expect(mockedRoutes.upsertTelnyxVoiceRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        toE164: "+15551234567",
        businessId: "biz",
        mediaWssOrigin: "wss://x"
      }),
      expect.anything()
    );
  });

  it("prefers existing bridge origin on the settings row", async () => {
    mockedRoutes.getBusinessTelnyxSettings.mockResolvedValue({
      ...sampleSettings,
      bridge_media_wss_origin: "wss://existing"
    });
    await assignExistingDidToBusiness({
      businessId: "biz",
      toE164: "+15551234567",
      platformDefaults: { bridgeMediaWssOrigin: "wss://platform" }
    });
    expect(mockedRoutes.upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeMediaWssOrigin: "wss://existing" }),
      expect.anything()
    );
  });

  it("falls back to platform default when settings row has no bridge origin", async () => {
    mockedRoutes.getBusinessTelnyxSettings.mockResolvedValue({
      ...sampleSettings,
      bridge_media_wss_origin: null
    });
    await assignExistingDidToBusiness({
      businessId: "biz",
      toE164: "+15551234567",
      platformDefaults: { bridgeMediaWssOrigin: "wss://platform" }
    });
    expect(mockedRoutes.upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeMediaWssOrigin: "wss://platform" }),
      expect.anything()
    );
  });

  it("null defaults when no existing settings and no platform defaults supplied", async () => {
    await assignExistingDidToBusiness({
      businessId: "biz",
      toE164: "+15551234567"
    });
    expect(mockedRoutes.upsertBusinessTelnyxSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeMediaWssOrigin: null,
        telnyxConnectionId: null,
        telnyxMessagingProfileId: null
      }),
      expect.anything()
    );
  });

  it("calls Telnyx PATCH when associateWithPlatform=true", async () => {
    const tn = makeTelnyxMock();
    await assignExistingDidToBusiness(
      {
        businessId: "biz",
        toE164: "+15551234567",
        associateWithPlatform: true,
        platformDefaults: { connectionId: "conn", messagingProfileId: "prof" }
      },
      { telnyxNumbers: tn }
    );
    expect(tn.updatePhoneNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberIdOrE164: "+15551234567",
        connectionId: "conn",
        messagingProfileId: "prof",
        customerReference: "business:biz"
      })
    );
  });

  it("PATCH omits connection/messaging when platformDefaults is empty", async () => {
    const tn = makeTelnyxMock();
    await assignExistingDidToBusiness(
      {
        businessId: "biz",
        toE164: "+15551234567",
        associateWithPlatform: true,
        platformDefaults: {}
      },
      { telnyxNumbers: tn }
    );
    const call = (tn.updatePhoneNumber as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.connectionId).toBeUndefined();
    expect(call.messagingProfileId).toBeUndefined();
    expect(call.customerReference).toBe("business:biz");
  });

  it("throws when associateWithPlatform=true but no Telnyx client is provided", async () => {
    await expect(
      assignExistingDidToBusiness({
        businessId: "biz",
        toE164: "+15551234567",
        associateWithPlatform: true
      })
    ).rejects.toThrow(/telnyxNumbers client required/);
  });

  it("uses provided supabase client instead of creating one", async () => {
    const db = { fake: true };
    await assignExistingDidToBusiness(
      { businessId: "biz", toE164: "+15551234567" },
      { client: db as never }
    );
    expect(mockedRoutes.getBusinessTelnyxSettings).toHaveBeenCalledWith("biz", db);
    expect(mockedRoutes.upsertBusinessTelnyxSettings).toHaveBeenCalledWith(expect.anything(), db);
    expect(mockedRoutes.upsertTelnyxVoiceRoute).toHaveBeenCalledWith(expect.anything(), db);
  });
});

describe("orderAndAssignDidForBusiness", () => {
  beforeEach(() => {
    mockedRoutes.upsertTelnyxVoiceRoute.mockReset();
    mockedRoutes.upsertBusinessTelnyxSettings.mockReset();
    mockedRoutes.getBusinessTelnyxSettings.mockReset();
    mockedRoutes.upsertTelnyxVoiceRoute.mockResolvedValue(sampleRoute);
    mockedRoutes.upsertBusinessTelnyxSettings.mockResolvedValue(sampleSettings);
    mockedRoutes.getBusinessTelnyxSettings.mockResolvedValue(null);
  });

  it("happy path: searches, orders, waits, assigns", async () => {
    const tn = makeTelnyxMock();
    const res = await orderAndAssignDidForBusiness(
      {
        businessId: "biz",
        platformDefaults: { connectionId: "conn", messagingProfileId: "prof" },
        search: { areaCode: "212" }
      },
      { telnyxNumbers: tn }
    );
    expect(res.orderId).toBe("ord_1");
    expect(res.route).toEqual(sampleRoute);
    expect(tn.searchAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ areaCode: "212", features: ["sms", "voice"] })
    );
    expect(tn.orderNumbers).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumbers: ["+15551234567"],
        connectionId: "conn",
        messagingProfileId: "prof",
        customerReference: "business:biz"
      })
    );
    // No double-association PATCH because order already set associations
    expect(tn.updatePhoneNumber).not.toHaveBeenCalled();
  });

  it("throws no_numbers_available when search returns empty", async () => {
    const tn = makeTelnyxMock({ searchAvailable: vi.fn().mockResolvedValue([]) } as never);
    try {
      await orderAndAssignDidForBusiness(
        { businessId: "biz", search: {} },
        { telnyxNumbers: tn }
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrderAndAssignError);
      expect((err as OrderAndAssignError).reason).toBe("no_numbers_available");
    }
  });

  it("throws order_not_success when Telnyx returns failure", async () => {
    const tn = makeTelnyxMock({
      waitForNumberOrder: vi
        .fn()
        .mockResolvedValue({ id: "ord", status: "failure", phone_numbers: [] })
    } as never);
    await expect(
      orderAndAssignDidForBusiness({ businessId: "biz", search: {} }, { telnyxNumbers: tn })
    ).rejects.toMatchObject({ reason: "order_not_success" });
  });

  it("throws missing_ordered_number when shipped numbers don't include the pick", async () => {
    const tn = makeTelnyxMock({
      waitForNumberOrder: vi
        .fn()
        .mockResolvedValue({ id: "ord", status: "success", phone_numbers: [{ phone_number: "+19990000000" }] })
    } as never);
    await expect(
      orderAndAssignDidForBusiness({ businessId: "biz", search: {} }, { telnyxNumbers: tn })
    ).rejects.toMatchObject({ reason: "missing_ordered_number" });
  });

  it("passes features + country overrides through", async () => {
    const tn = makeTelnyxMock();
    await orderAndAssignDidForBusiness(
      {
        businessId: "biz",
        search: { countryCode: "CA", features: ["sms"] },
        orderTimeoutMs: 5_000
      },
      { telnyxNumbers: tn }
    );
    expect(tn.searchAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: "CA", features: ["sms"] })
    );
    expect(tn.waitForNumberOrder).toHaveBeenCalledWith("ord_1", expect.objectContaining({ timeoutMs: 5_000 }));
  });

  it("orders the exact number when specificNumber is provided (skips search)", async () => {
    const tn = makeTelnyxMock({
      // If the code incorrectly re-searched, this would return a different
      // number and the test would fail.
      searchAvailable: vi.fn().mockResolvedValue([{ phone_number: "+19999999999" }]),
      waitForNumberOrder: vi.fn().mockResolvedValue({
        id: "ord_2",
        status: "success",
        phone_numbers: [{ phone_number: "+16025551234" }]
      })
    } as never);
    const res = await orderAndAssignDidForBusiness(
      {
        businessId: "biz",
        specificNumber: "+1 (602) 555-1234",
        search: { areaCode: "602" }
      },
      { telnyxNumbers: tn }
    );
    expect(tn.searchAvailable).not.toHaveBeenCalled();
    expect(tn.orderNumbers).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumbers: ["+16025551234"] })
    );
    expect(res.orderId).toBe("ord_2");
  });

  it("ignores an empty/whitespace specificNumber and falls back to search", async () => {
    const tn = makeTelnyxMock();
    await orderAndAssignDidForBusiness(
      { businessId: "biz", specificNumber: "   ", search: { areaCode: "212" } },
      { telnyxNumbers: tn }
    );
    expect(tn.searchAvailable).toHaveBeenCalled();
  });

  it("OrderAndAssignError exposes optional order payload", () => {
    const err = new OrderAndAssignError("order_not_success", "x", {
      id: "o",
      status: "failure"
    });
    expect(err.reason).toBe("order_not_success");
    expect(err.order?.id).toBe("o");
    const err2 = new OrderAndAssignError("no_numbers_available", "y");
    expect(err2.order).toBeUndefined();
  });
});
