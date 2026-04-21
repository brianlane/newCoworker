import { describe, it, expect } from "vitest";
import { readPlatformTelnyxDefaults } from "@/lib/telnyx/platform-defaults";

describe("readPlatformTelnyxDefaults", () => {
  it("reads all three env vars", () => {
    expect(
      readPlatformTelnyxDefaults({
        TELNYX_CONNECTION_ID: "conn",
        TELNYX_MESSAGING_PROFILE_ID: "prof",
        BRIDGE_MEDIA_WSS_ORIGIN: "wss://x"
      })
    ).toEqual({
      connectionId: "conn",
      messagingProfileId: "prof",
      bridgeMediaWssOrigin: "wss://x"
    });
  });

  it("returns undefined for missing keys", () => {
    expect(readPlatformTelnyxDefaults({})).toEqual({
      connectionId: undefined,
      messagingProfileId: undefined,
      bridgeMediaWssOrigin: undefined
    });
  });

  it("defaults env arg to process.env when omitted", () => {
    const out = readPlatformTelnyxDefaults();
    expect(out).toHaveProperty("connectionId");
    expect(out).toHaveProperty("messagingProfileId");
    expect(out).toHaveProperty("bridgeMediaWssOrigin");
  });
});
