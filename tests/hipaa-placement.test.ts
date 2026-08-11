import { describe, it, expect } from "vitest";
import {
  assertHipaaPlacement,
  hipaaModeEnabled,
  hipaaPlacementAllowed,
  HipaaPlacementError,
  HIPAA_ELIGIBLE_PROVIDERS
} from "@/lib/hipaa/placement";

describe("hipaa/placement", () => {
  describe("HIPAA_ELIGIBLE_PROVIDERS", () => {
    it("is BYOS only, and deliberately excludes the default fleet", () => {
      // Hostinger's hosting agreement excludes HIPAA outright, so this list
      // growing is a decision that must come with a BAA behind it.
      expect([...HIPAA_ELIGIBLE_PROVIDERS]).toEqual(["byos"]);
    });
  });

  describe("hipaaPlacementAllowed", () => {
    it("allows a customer-owned box", () => {
      expect(hipaaPlacementAllowed("byos")).toBe(true);
    });

    it("refuses hostinger and ovh", () => {
      expect(hipaaPlacementAllowed("hostinger")).toBe(false);
      expect(hipaaPlacementAllowed("ovh")).toBe(false);
    });

    it("refuses null and garbage, which resolve to the hostinger default", () => {
      expect(hipaaPlacementAllowed(null)).toBe(false);
      expect(hipaaPlacementAllowed(undefined)).toBe(false);
      expect(hipaaPlacementAllowed("garbage")).toBe(false);
    });
  });

  describe("hipaaModeEnabled", () => {
    it("is true only for a literal true, never a truthy value", () => {
      expect(hipaaModeEnabled(true)).toBe(true);
      expect(hipaaModeEnabled(false)).toBe(false);
      expect(hipaaModeEnabled(null)).toBe(false);
      expect(hipaaModeEnabled(undefined)).toBe(false);
      expect(hipaaModeEnabled("true")).toBe(false);
      expect(hipaaModeEnabled(1)).toBe(false);
    });
  });

  describe("assertHipaaPlacement", () => {
    it("no-ops for every tenant that has not opted in", () => {
      // The overwhelmingly common case: nothing about the HIPAA lane may
      // affect a normal Hostinger tenant.
      expect(() =>
        assertHipaaPlacement({ vps_provider: "hostinger", data_residency_mode: "supabase" })
      ).not.toThrow();
      expect(() => assertHipaaPlacement({})).not.toThrow();
      expect(() => assertHipaaPlacement({ hipaa_mode: false })).not.toThrow();
      expect(() => assertHipaaPlacement({ hipaa_mode: null })).not.toThrow();
    });

    it("refuses a HIPAA tenant on the default Hostinger fleet", () => {
      expect(() =>
        assertHipaaPlacement({
          hipaa_mode: true,
          vps_provider: "hostinger",
          data_residency_mode: "vps"
        })
      ).toThrow(HipaaPlacementError);
    });

    it("names the offending provider in the message", () => {
      expect(() =>
        assertHipaaPlacement({ hipaa_mode: true, vps_provider: "ovh", data_residency_mode: "vps" })
      ).toThrow(/'ovh' box/);
    });

    it("refuses a HIPAA tenant with no provider set, which defaults to hostinger", () => {
      expect(() => assertHipaaPlacement({ hipaa_mode: true, data_residency_mode: "vps" })).toThrow(
        /'hostinger' box/
      );
    });

    it("refuses an eligible placement whose content still lives in central Supabase", () => {
      expect(() =>
        assertHipaaPlacement({
          hipaa_mode: true,
          vps_provider: "byos",
          data_residency_mode: "supabase"
        })
      ).toThrow(/data_residency_mode is still 'supabase'/);
    });

    it("treats a missing residency mode as the 'supabase' default and refuses", () => {
      expect(() => assertHipaaPlacement({ hipaa_mode: true, vps_provider: "byos" })).toThrow(
        HipaaPlacementError
      );
    });

    it("passes a BYOS tenant in dual or vps residency", () => {
      expect(() =>
        assertHipaaPlacement({
          hipaa_mode: true,
          vps_provider: "byos",
          data_residency_mode: "dual"
        })
      ).not.toThrow();
      expect(() =>
        assertHipaaPlacement({
          hipaa_mode: true,
          vps_provider: "byos",
          data_residency_mode: "vps"
        })
      ).not.toThrow();
    });

    it("checks placement before residency, so the worse problem is reported first", () => {
      // Both are wrong here. The placement message is the actionable one:
      // fixing residency on a Hostinger box would still leave PHI uncovered.
      expect(() =>
        assertHipaaPlacement({
          hipaa_mode: true,
          vps_provider: "hostinger",
          data_residency_mode: "supabase"
        })
      ).toThrow(/no Business Associate Agreement covers/);
    });
  });
});
