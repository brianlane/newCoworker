import { describe, it, expect } from "vitest";
import {
  assertPlatformTelnyxDefaults,
  MissingTelnyxDefaultsError,
  readPlatformTelnyxDefaults
} from "@/lib/telnyx/platform-defaults";

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

describe("assertPlatformTelnyxDefaults", () => {
  it("passes silently when both connectionId and messagingProfileId are non-empty strings", () => {
    expect(() =>
      assertPlatformTelnyxDefaults({
        connectionId: "conn-123",
        messagingProfileId: "prof-abc"
      })
    ).not.toThrow();
  });

  it("does NOT require bridgeMediaWssOrigin — bridges can come up after DID assignment", () => {
    // Stricter validation here would block bootstrapping orders since
    // the per-tenant tunnel + bridge are stood up AFTER the DID assigns
    // routing on Telnyx. The Edge dispatcher resolves the WSS origin
    // off business_telnyx_settings at call time, so it's fine for the
    // origin to be empty at provision time.
    expect(() =>
      assertPlatformTelnyxDefaults({
        connectionId: "conn-123",
        messagingProfileId: "prof-abc"
        // no bridgeMediaWssOrigin
      })
    ).not.toThrow();
  });

  it("throws MissingTelnyxDefaultsError listing connectionId when it's missing — root cause of the unwired-DID outage", () => {
    try {
      assertPlatformTelnyxDefaults({
        connectionId: undefined,
        messagingProfileId: "prof-abc"
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTelnyxDefaultsError);
      const e = err as MissingTelnyxDefaultsError;
      expect(e.missing).toEqual(["connectionId"]);
      expect(e.message).toMatch(/connectionId/);
      expect(e.message).toMatch(/Refusing to provision/);
    }
  });

  it("treats whitespace-only connectionId as missing — caller env is sometimes a stray blank", () => {
    try {
      assertPlatformTelnyxDefaults({
        connectionId: "   ",
        messagingProfileId: "prof-abc"
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTelnyxDefaultsError);
      expect((err as MissingTelnyxDefaultsError).missing).toEqual(["connectionId"]);
    }
  });

  it("throws when messagingProfileId is missing", () => {
    try {
      assertPlatformTelnyxDefaults({
        connectionId: "conn-123",
        messagingProfileId: undefined
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTelnyxDefaultsError);
      expect((err as MissingTelnyxDefaultsError).missing).toEqual(["messagingProfileId"]);
    }
  });

  it("reports both missing fields together so the operator fixes the env in one round-trip", () => {
    try {
      assertPlatformTelnyxDefaults({});
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTelnyxDefaultsError);
      expect((err as MissingTelnyxDefaultsError).missing).toEqual([
        "connectionId",
        "messagingProfileId"
      ]);
    }
  });
});
