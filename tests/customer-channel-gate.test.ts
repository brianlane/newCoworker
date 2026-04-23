import { describe, expect, it } from "vitest";
import { evaluateCustomerChannelGate } from "../supabase/functions/_shared/customer_channel_gate";

describe("evaluateCustomerChannelGate (precedence: is_paused > safe_mode > normal)", () => {
  const owner = "+15555550123";

  it("returns normal when nothing is engaged", () => {
    expect(
      evaluateCustomerChannelGate({
        isPaused: false,
        customerChannelsEnabled: true,
        forwardToE164: null
      })
    ).toEqual({ kind: "normal" });
  });

  it("returns paused when is_paused is true (ignores safe mode)", () => {
    expect(
      evaluateCustomerChannelGate({
        isPaused: true,
        customerChannelsEnabled: false,
        forwardToE164: owner
      })
    ).toEqual({ kind: "paused" });
  });

  it("returns safe_mode_forward when customer_channels_enabled=false with forward", () => {
    expect(
      evaluateCustomerChannelGate({
        isPaused: false,
        customerChannelsEnabled: false,
        forwardToE164: owner
      })
    ).toEqual({ kind: "safe_mode_forward", forwardToE164: owner });
  });

  it("falls back to paused when safe mode is on but forward is missing", () => {
    expect(
      evaluateCustomerChannelGate({
        isPaused: false,
        customerChannelsEnabled: false,
        forwardToE164: null
      })
    ).toEqual({ kind: "paused" });
  });

  it("falls back to paused when safe mode is on but forward is blank", () => {
    expect(
      evaluateCustomerChannelGate({
        isPaused: false,
        customerChannelsEnabled: false,
        forwardToE164: "   "
      })
    ).toEqual({ kind: "paused" });
  });

  it("is_paused wins even with normal channels enabled", () => {
    expect(
      evaluateCustomerChannelGate({
        isPaused: true,
        customerChannelsEnabled: true,
        forwardToE164: null
      })
    ).toEqual({ kind: "paused" });
  });

  it("trims whitespace on forward number in safe_mode result", () => {
    expect(
      evaluateCustomerChannelGate({
        isPaused: false,
        customerChannelsEnabled: false,
        forwardToE164: "  +15555550123  "
      })
    ).toEqual({ kind: "safe_mode_forward", forwardToE164: owner });
  });
});
