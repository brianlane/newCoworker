import { describe, expect, it } from "vitest";
import {
  allowedCountries,
  assertContainsLiveTrafficRegions,
  LIVE_TRAFFIC_REGIONS,
  REGIONS_WITHOUT_OWN_DIAL_PREFIX
} from "../scripts/oneshot/widen-telnyx-allowlist";

// Pins the membership that the Aug 6 2026 Canada outage proved matters:
// the dial table classifies bare +1 as US, so Canada can never come out of
// it, and a table-derived Telnyx whitelist silently drops CA. Every SMS to
// a Canadian number then fails at Telnyx with 40309 "Invalid destination
// region 'CA'".

describe("allowedCountries", () => {
  it("includes Canada even though the dial table cannot express it", () => {
    expect(allowedCountries()).toContain("CA");
  });

  it("includes every live-traffic region", () => {
    const allowed = allowedCountries();
    for (const region of LIVE_TRAFFIC_REGIONS) {
      expect(allowed).toContain(region);
    }
  });

  it("keeps the NANP regions that DO have their own prefixes", () => {
    const allowed = allowedCountries();
    // Puerto Rico (+1787), Jamaica (+1876), Dominican Republic (+1809):
    // these come from dial-table overrides and survived the outage; the
    // fix must not disturb them.
    for (const region of ["PR", "JM", "DO"]) {
      expect(allowed).toContain(region);
    }
  });

  it("still excludes the destination denylist", () => {
    const allowed = allowedCountries();
    for (const blocked of ["CU", "KP", "SO"]) {
      expect(allowed).not.toContain(blocked);
    }
  });

  it("declares CA as the only known prefixless region", () => {
    expect([...REGIONS_WITHOUT_OWN_DIAL_PREFIX]).toEqual(["CA"]);
  });
});

describe("assertContainsLiveTrafficRegions", () => {
  it("passes a complete list", () => {
    expect(() => assertContainsLiveTrafficRegions(["US", "CA", "MX", "GB"])).not.toThrow();
  });

  it("throws when Canada is missing, naming the outage", () => {
    expect(() => assertContainsLiveTrafficRegions(["US", "MX"])).toThrow(/CA/);
    expect(() => assertContainsLiveTrafficRegions(["US", "MX"])).toThrow(/Canada outage/);
  });
});
