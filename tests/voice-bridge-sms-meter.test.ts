/**
 * The bridge's operational SMS meter: every successful bridge send
 * (missed-call fallback, intake lead summary, transfer pre-alert) counts
 * against the tenant's operational pool through the same RPC the
 * notifications function uses. These sends used to claim "tracked on the
 * Edge/web side" while nothing counted them.
 */
import { describe, expect, it, vi } from "vitest";

import { meterBridgeOperationalSms } from "../vps/voice-bridge/src/telnyx-call-actions";

const BIZ = "11111111-1111-4111-8111-111111111111";

describe("meterBridgeOperationalSms", () => {
  it("passes the send's billable text units, never a flat 1", async () => {
    // #1189 re-denominated the enforced ledger in carrier parts; the bridge
    // was the last sender still metering every send as one unit, so a
    // 3000-char intake transcript SMS (about 20 GSM parts) recorded as 1.
    const rpc = vi.fn(async () => ({ data: { counted: true }, error: null }));
    await meterBridgeOperationalSms({ rpc }, BIZ, 9);
    expect(rpc).toHaveBeenCalledWith("meter_sms_operational_send", {
      p_business_id: BIZ,
      p_text_units: 9
    });
  });

  it("never throws: an rpc error or a thrown client only warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        meterBridgeOperationalSms(
          { rpc: vi.fn(async () => ({ data: null, error: { message: "rls" } })) },
          BIZ,
          1
        )
      ).resolves.toBeUndefined();

      await expect(
        meterBridgeOperationalSms(
          {
            rpc: vi.fn(() => {
              throw new Error("socket hang up");
            }) as never
          },
          BIZ,
          1
        )
      ).resolves.toBeUndefined();

      await expect(
        meterBridgeOperationalSms(
          {
            rpc: vi.fn(() => {
              throw "string blast";
            }) as never
          },
          BIZ,
          1
        )
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
