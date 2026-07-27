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
  it("counts one send through meter_sms_operational_send", async () => {
    const rpc = vi.fn(async () => ({ data: { counted: true }, error: null }));
    await meterBridgeOperationalSms({ rpc }, BIZ);
    expect(rpc).toHaveBeenCalledWith("meter_sms_operational_send", { p_business_id: BIZ });
  });

  it("never throws: an rpc error or a thrown client only warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        meterBridgeOperationalSms(
          { rpc: vi.fn(async () => ({ data: null, error: { message: "rls" } })) },
          BIZ
        )
      ).resolves.toBeUndefined();

      await expect(
        meterBridgeOperationalSms(
          {
            rpc: vi.fn(() => {
              throw new Error("socket hang up");
            }) as never
          },
          BIZ
        )
      ).resolves.toBeUndefined();

      await expect(
        meterBridgeOperationalSms(
          {
            rpc: vi.fn(() => {
              throw "string blast";
            }) as never
          },
          BIZ
        )
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
