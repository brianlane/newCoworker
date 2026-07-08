import { describe, expect, it } from "vitest";
import {
  VPS_PROVIDERS,
  VPS_REGIONS,
  VPS_PROVIDER_TIER_MESSAGE,
  VpsProviderValidationError,
  assertVpsProviderAllowed,
  isVpsProvider,
  isVpsRegion,
  providerAllowedForTier,
  providerUsesHostingerLifecycle,
  resolveVpsProvider,
  resolveVpsRegion
} from "@/lib/vps/provider";

describe("vps/provider: narrowing + resolution", () => {
  it("accepts every declared provider and region", () => {
    for (const p of VPS_PROVIDERS) expect(isVpsProvider(p)).toBe(true);
    for (const r of VPS_REGIONS) expect(isVpsRegion(r)).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isVpsProvider("aws")).toBe(false);
    expect(isVpsProvider(null)).toBe(false);
    expect(isVpsProvider(undefined)).toBe(false);
    expect(isVpsRegion("eu")).toBe(false);
    expect(isVpsRegion(null)).toBe(false);
  });

  it("resolveVpsProvider falls back to hostinger on null/legacy/corrupt values", () => {
    expect(resolveVpsProvider("byos")).toBe("byos");
    expect(resolveVpsProvider("ovh")).toBe("ovh");
    expect(resolveVpsProvider("hostinger")).toBe("hostinger");
    // Legacy rows pre-dating the column and corrupt strings must NEVER
    // route a fleet tenant off the Hostinger lifecycle path.
    expect(resolveVpsProvider(null)).toBe("hostinger");
    expect(resolveVpsProvider(undefined)).toBe("hostinger");
    expect(resolveVpsProvider("garbage")).toBe("hostinger");
  });

  it("resolveVpsRegion falls back to us", () => {
    expect(resolveVpsRegion("ca")).toBe("ca");
    expect(resolveVpsRegion("us")).toBe("us");
    expect(resolveVpsRegion(null)).toBe("us");
    expect(resolveVpsRegion("garbage")).toBe("us");
  });
});

describe("vps/provider: enterprise tier gate", () => {
  it("hostinger is allowed for every tier (including null/legacy)", () => {
    expect(providerAllowedForTier("hostinger", "starter")).toBe(true);
    expect(providerAllowedForTier("hostinger", "standard")).toBe(true);
    expect(providerAllowedForTier("hostinger", "enterprise")).toBe(true);
    expect(providerAllowedForTier("hostinger", null)).toBe(true);
  });

  it("byos/ovh are enterprise-only", () => {
    expect(providerAllowedForTier("byos", "enterprise")).toBe(true);
    expect(providerAllowedForTier("ovh", "enterprise")).toBe(true);
    expect(providerAllowedForTier("byos", "standard")).toBe(false);
    expect(providerAllowedForTier("ovh", "starter")).toBe(false);
    expect(providerAllowedForTier("byos", null)).toBe(false);
    expect(providerAllowedForTier("byos", undefined)).toBe(false);
  });

  it("assertVpsProviderAllowed throws the typed error with the tier message", () => {
    expect(() => assertVpsProviderAllowed("byos", "standard")).toThrowError(
      VPS_PROVIDER_TIER_MESSAGE
    );
    try {
      assertVpsProviderAllowed("ovh", "starter");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VpsProviderValidationError);
      expect((err as Error).name).toBe("VpsProviderValidationError");
    }
    expect(() => assertVpsProviderAllowed("byos", "enterprise")).not.toThrow();
    expect(() => assertVpsProviderAllowed("hostinger", "starter")).not.toThrow();
  });
});

describe("vps/provider: lifecycle routing", () => {
  it("only hostinger uses the Hostinger lifecycle (pool, billing ops, hPanel email)", () => {
    expect(providerUsesHostingerLifecycle("hostinger")).toBe(true);
    expect(providerUsesHostingerLifecycle("byos")).toBe(false);
    expect(providerUsesHostingerLifecycle("ovh")).toBe(false);
  });
});
