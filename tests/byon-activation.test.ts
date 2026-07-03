import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/telnyx/assign-did", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telnyx/assign-did")>();
  return { ...actual, assignExistingDidToBusiness: vi.fn() };
});

vi.mock("@/lib/provisioning/tendlc-attach", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provisioning/tendlc-attach")>();
  return { ...actual, attachBusinessDidToCampaign: vi.fn() };
});

vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: vi.fn()
}));

vi.mock("@/lib/telnyx/numbers", () => ({
  // Regular function so `new TelnyxNumbersClient(...)` works (arrows can't
  // be constructed).
  TelnyxNumbersClient: vi.fn(function TelnyxNumbersClient() {
    return { tag: "numbers-client" };
  })
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { activatePortedNumber, type PortedNumberRow } from "@/lib/byon/activation";
import { assignExistingDidToBusiness } from "@/lib/telnyx/assign-did";
import { attachBusinessDidToCampaign } from "@/lib/provisioning/tendlc-attach";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import { logger } from "@/lib/logger";

const assignMock = vi.mocked(assignExistingDidToBusiness);
const attachMock = vi.mocked(attachBusinessDidToCampaign);
const dispatchMock = vi.mocked(dispatchUrgentNotification);

const ROW: PortedNumberRow = {
  id: "req-1",
  business_id: "biz-1",
  phone_e164: "+13125550001",
  telnyx_order_id: "po-1"
};

const ENV = {
  TELNYX_API_KEY: "key",
  TELNYX_CONNECTION_ID: "conn-1",
  TELNYX_MESSAGING_PROFILE_ID: "mp-1",
  BRIDGE_MEDIA_WSS_ORIGIN: "wss://bridge.example"
};

const ASSIGN_RESULT = {
  route: { to_e164: "+13125550001" },
  settings: { business_id: "biz-1" }
} as never;

describe("activatePortedNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignMock.mockResolvedValue(ASSIGN_RESULT);
    attachMock.mockResolvedValue({ kind: "registered", campaignId: "c-1" });
    dispatchMock.mockResolvedValue({ results: [] });
  });

  it("wires voice routes and 10DLC for the ported number using platform defaults", async () => {
    const result = await activatePortedNumber(ROW, { env: ENV });

    expect(result).toEqual({
      activated: true,
      assign: ASSIGN_RESULT,
      tendlc: { kind: "registered", campaignId: "c-1" },
      error: null
    });
    expect(assignMock).toHaveBeenCalledWith(
      {
        businessId: "biz-1",
        toE164: "+13125550001",
        platformDefaults: {
          connectionId: "conn-1",
          messagingProfileId: "mp-1",
          bridgeMediaWssOrigin: "wss://bridge.example"
        },
        associateWithPlatform: true
      },
      { telnyxNumbers: expect.objectContaining({ tag: "numbers-client" }) }
    );
    expect(TelnyxNumbersClient).toHaveBeenCalledWith({ apiKey: "key" });
    expect(attachMock).toHaveBeenCalledWith({ businessId: "biz-1", toE164: "+13125550001" });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "byon: ported number activated",
      expect.objectContaining({ portRequestId: "req-1", tendlc: "registered" })
    );
  });

  it("uses an injected numbers client and process.env by default", async () => {
    vi.stubEnv("TELNYX_API_KEY", "env-key");
    vi.stubEnv("TELNYX_CONNECTION_ID", "conn-env");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "mp-env");
    try {
      const injected = { tag: "injected" } as never;
      const result = await activatePortedNumber(ROW, { numbersClient: injected });
      expect(result.activated).toBe(true);
      expect(TelnyxNumbersClient).not.toHaveBeenCalled();
      expect(assignMock).toHaveBeenCalledWith(
        expect.objectContaining({
          platformDefaults: expect.objectContaining({ connectionId: "conn-env" })
        }),
        { telnyxNumbers: injected }
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts injected assign/attach/dispatch deps", async () => {
    const assign = vi.fn().mockResolvedValue(ASSIGN_RESULT);
    const attach = vi.fn().mockResolvedValue({ kind: "pending", reason: "campaign_status:PENDING" });
    const dispatch = vi.fn();
    const result = await activatePortedNumber(ROW, {
      env: ENV,
      assign: assign as never,
      attach: attach as never,
      dispatch: dispatch as never
    });
    expect(result.activated).toBe(true);
    expect(result.tendlc).toEqual({ kind: "pending", reason: "campaign_status:PENDING" });
    expect(assign).toHaveBeenCalled();
    expect(attach).toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    // pending is normal right after a port — no warning noise.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails loudly (alerting the owner) when TELNYX_API_KEY is missing", async () => {
    const result = await activatePortedNumber(ROW, { env: { ...ENV, TELNYX_API_KEY: "  " } });
    expect(result).toEqual({
      activated: false,
      assign: null,
      tendlc: null,
      error: "TELNYX_API_KEY is not configured"
    });
    expect(assignMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "byon: ported number activation failed",
      expect.objectContaining({ error: "TELNYX_API_KEY is not configured" })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        kind: "byon_activation",
        payload: expect.objectContaining({
          activation_error: "TELNYX_API_KEY is not configured"
        })
      })
    );
  });

  it("fails when the platform defaults canary trips (blank connection id)", async () => {
    const result = await activatePortedNumber(ROW, {
      env: { ...ENV, TELNYX_CONNECTION_ID: undefined }
    });
    expect(result.activated).toBe(false);
    expect(result.error).toMatch(/connectionId/);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("fails when the assign flow throws, tolerating dispatch failures and non-Error throws", async () => {
    assignMock.mockRejectedValue(new Error("telnyx PATCH exploded"));
    dispatchMock.mockRejectedValue(new Error("smtp down"));
    const result = await activatePortedNumber(ROW, { env: ENV });
    expect(result).toEqual({
      activated: false,
      assign: null,
      tendlc: null,
      error: "telnyx PATCH exploded"
    });
    expect(attachMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: activation-failure notification failed",
      expect.objectContaining({ error: "smtp down" })
    );

    assignMock.mockRejectedValue("wat");
    dispatchMock.mockResolvedValue({ results: [] });
    const result2 = await activatePortedNumber(ROW, { env: ENV });
    expect(result2.error).toBe("wat");
  });

  it("treats 10DLC problems as non-fatal but logs rejected/error outcomes", async () => {
    attachMock.mockResolvedValue({ kind: "rejected", reason: "attach_failed: telnyx_422" });
    const result = await activatePortedNumber(ROW, { env: ENV });
    expect(result.activated).toBe(true);
    expect(result.tendlc).toEqual({ kind: "rejected", reason: "attach_failed: telnyx_422" });
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: 10DLC attach for ported number did not complete",
      expect.objectContaining({ reason: "attach_failed: telnyx_422" })
    );

    // attach throwing (it shouldn't, but belt-and-braces) → error outcome.
    attachMock.mockRejectedValue(new Error("network sneeze"));
    const result2 = await activatePortedNumber(ROW, { env: ENV });
    expect(result2.activated).toBe(true);
    expect(result2.tendlc).toEqual({ kind: "error", reason: "network sneeze" });
  });
});
