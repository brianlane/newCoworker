import { describe, expect, it } from "vitest";
import { ownerPhoneDeliverabilityWarning } from "@/lib/phone/deliverability";

const PLATFORM = { us: "prof-us", ca: "prof-ca", mx: "prof-mx" };

describe("ownerPhoneDeliverabilityWarning", () => {
  it("passes a US number on every profile", () => {
    for (const profile of ["prof-us", "prof-ca", "prof-mx", "custom", null, ""]) {
      expect(ownerPhoneDeliverabilityWarning("+16025550100", profile, PLATFORM)).toBeNull();
    }
  });

  it("warns for a Canadian number on the US-only profile, passes on CA/MX", () => {
    // 514 = Montreal; the US-only whitelist rejects it exactly like an
    // international destination (Telnyx 40309).
    expect(ownerPhoneDeliverabilityWarning("+15145188192", "prof-us", PLATFORM)).toMatch(
      /Canadian number/
    );
    // Missing/blank tenant profile falls back to the default (US-only).
    expect(ownerPhoneDeliverabilityWarning("+15145188192", null, PLATFORM)).toMatch(
      /Canadian number/
    );
    expect(ownerPhoneDeliverabilityWarning("+15145188192", "prof-ca", PLATFORM)).toBeNull();
    expect(ownerPhoneDeliverabilityWarning("+15145188192", "prof-mx", PLATFORM)).toBeNull();
  });

  it("gives an unknown/custom profile the benefit of the doubt for NANP", () => {
    expect(ownerPhoneDeliverabilityWarning("+15145188192", "enterprise-custom", PLATFORM)).toBeNull();
  });

  it("passes a Mexican number only on the MX profile", () => {
    expect(ownerPhoneDeliverabilityWarning("+525512345678", "prof-mx", PLATFORM)).toBeNull();
    for (const profile of ["prof-us", "prof-ca", "custom", null]) {
      expect(ownerPhoneDeliverabilityWarning("+525512345678", profile, PLATFORM)).toMatch(
        /Mexican number/
      );
    }
  });

  it("warns for any other country code on every profile (none cover it today)", () => {
    // Hong Kong: the request that started all of this.
    for (const profile of ["prof-us", "prof-ca", "prof-mx", "custom", null]) {
      expect(ownerPhoneDeliverabilityWarning("+85261234567", profile, PLATFORM)).toMatch(
        /not covered/
      );
    }
  });

  it("treats a structurally odd +1 number as US (no NPA extractable, no CA warn)", () => {
    // 15 digits after +1 is not NANP; nanpNpaFromPhone returns null and the
    // number passes as generic +1 (the send-side coercion guards dialability).
    expect(ownerPhoneDeliverabilityWarning("+1234", "prof-us", PLATFORM)).toBeNull();
  });

  it("handles unset platform env ids without false matches", () => {
    // With no MX env id configured, an empty tenant profile must not
    // accidentally equal an empty platform id and read as MX coverage.
    expect(
      ownerPhoneDeliverabilityWarning("+525512345678", "", { us: undefined, ca: null, mx: "" })
    ).toMatch(/Mexican number/);
    // A concrete tenant profile against fully-unset platform ids: nothing
    // matches, NANP gets the custom-profile benefit of the doubt.
    expect(
      ownerPhoneDeliverabilityWarning("+15145188192", "prof-x", {
        us: undefined,
        ca: undefined,
        mx: undefined
      })
    ).toBeNull();
  });
});
