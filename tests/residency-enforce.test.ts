import { describe, expect, it } from "vitest";
import {
  ResidencyPlacementError,
  assertResidencyForPlacement,
  placementRequiresResidency
} from "@/lib/residency/enforce";

describe("placementRequiresResidency", () => {
  it("requires residency for byos boxes and Canadian regions", () => {
    expect(placementRequiresResidency("byos", "us")).toBe(true);
    expect(placementRequiresResidency("byos", "ca")).toBe(true);
    expect(placementRequiresResidency("ovh", "ca")).toBe(true);
    expect(placementRequiresResidency("hostinger", "ca")).toBe(true);
  });

  it("does not require residency for the default fleet placement", () => {
    expect(placementRequiresResidency("hostinger", "us")).toBe(false);
    expect(placementRequiresResidency(null, null)).toBe(false);
    // Corrupt values resolve to the safe defaults (hostinger/us).
    expect(placementRequiresResidency("garbage", "garbage")).toBe(false);
    // OVH in the US region (not a Canadian-residency deal) is not gated.
    expect(placementRequiresResidency("ovh", "us")).toBe(false);
  });
});

describe("assertResidencyForPlacement", () => {
  it("throws for a byos placement still in supabase mode (message names the placement)", () => {
    expect(() =>
      assertResidencyForPlacement({ vps_provider: "byos", data_residency_mode: "supabase" })
    ).toThrow(ResidencyPlacementError);
    expect(() =>
      assertResidencyForPlacement({ vps_provider: "byos" })
    ).toThrow(/customer-owned \(BYOS\) box/);
    expect(() =>
      assertResidencyForPlacement({ vps_provider: "ovh", vps_region: "ca" })
    ).toThrow(/Canadian-region box/);
  });

  it("passes once residency is at least dual, and for non-gated placements", () => {
    expect(() =>
      assertResidencyForPlacement({ vps_provider: "byos", data_residency_mode: "dual" })
    ).not.toThrow();
    expect(() =>
      assertResidencyForPlacement({
        vps_provider: "ovh",
        vps_region: "ca",
        data_residency_mode: "vps"
      })
    ).not.toThrow();
    expect(() => assertResidencyForPlacement({})).not.toThrow();
    expect(() =>
      assertResidencyForPlacement({ vps_provider: "hostinger", data_residency_mode: "supabase" })
    ).not.toThrow();
  });
});
