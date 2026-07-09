import { describe, expect, it } from "vitest";
import {
  buildDidSearchPlan,
  countryForNpa,
  normalizePreferredAreaCode,
  CANADIAN_NPAS
} from "@/lib/telnyx/did-search-plan";

describe("normalizePreferredAreaCode", () => {
  it("accepts clean 3-digit NPAs", () => {
    expect(normalizePreferredAreaCode("519")).toBe("519");
    expect(normalizePreferredAreaCode("602")).toBe("602");
  });

  it("strips decoration before validating", () => {
    expect(normalizePreferredAreaCode("(519)")).toBe("519");
    expect(normalizePreferredAreaCode(" 416 ")).toBe("416");
    expect(normalizePreferredAreaCode("905-")).toBe("905");
  });

  it("rejects NPAs starting with 0/1, wrong lengths, and junk", () => {
    expect(normalizePreferredAreaCode("119")).toBeNull();
    expect(normalizePreferredAreaCode("05")).toBeNull();
    expect(normalizePreferredAreaCode("5190")).toBeNull();
    expect(normalizePreferredAreaCode("abc")).toBeNull();
    expect(normalizePreferredAreaCode("")).toBeNull();
    expect(normalizePreferredAreaCode(null)).toBeNull();
    expect(normalizePreferredAreaCode(undefined)).toBeNull();
  });
});

describe("countryForNpa", () => {
  it("maps Canadian NPAs to CA regardless of the default", () => {
    expect(countryForNpa("519", "US")).toBe("CA");
    expect(countryForNpa("416", "US")).toBe("CA");
    expect(countryForNpa("604", "US")).toBe("CA");
  });

  it("maps non-Canadian NPAs to the default country", () => {
    expect(countryForNpa("602", "US")).toBe("US");
    expect(countryForNpa("212", "US")).toBe("US");
  });

  it("every table entry is a structurally valid NPA", () => {
    for (const npa of CANADIAN_NPAS) {
      expect(npa).toMatch(/^[2-9]\d{2}$/);
    }
  });
});

describe("buildDidSearchPlan", () => {
  it("orders requested → owner → default → any with per-NPA countries", () => {
    const plan = buildDidSearchPlan({
      preferredAreaCode: "519",
      ownerAreaCode: "416",
      defaultCountry: "US",
      defaultAreaCode: "212",
      defaultState: "NY"
    });
    expect(plan).toEqual([
      { source: "requested", countryCode: "CA", areaCode: "519", administrativeArea: undefined },
      { source: "owner_local", countryCode: "CA", areaCode: "416", administrativeArea: undefined },
      { source: "platform_default", countryCode: "US", areaCode: "212", administrativeArea: "NY" },
      { source: "any", countryCode: "US", areaCode: undefined, administrativeArea: undefined }
    ]);
  });

  it("dedupes the owner tier when it matches the requested NPA", () => {
    const plan = buildDidSearchPlan({
      preferredAreaCode: "602",
      ownerAreaCode: "602",
      defaultCountry: "US",
      defaultAreaCode: "212",
      defaultState: "NY"
    });
    expect(plan.map((s) => s.source)).toEqual(["requested", "platform_default", "any"]);
  });

  it("dedupes the platform-default tier when an earlier tier already covers its NPA", () => {
    const plan = buildDidSearchPlan({
      preferredAreaCode: null,
      ownerAreaCode: "602",
      defaultCountry: "US",
      defaultAreaCode: "602",
      defaultState: "AZ"
    });
    // The 602 default would re-run the identical owner search narrowed by
    // state — dropped, leaving owner then any.
    expect(plan.map((s) => s.source)).toEqual(["owner_local", "any"]);
  });

  it("degrades to default-only when nothing is derivable", () => {
    const plan = buildDidSearchPlan({
      preferredAreaCode: null,
      ownerAreaCode: null,
      defaultCountry: "US",
      defaultAreaCode: "305",
      defaultState: "FL"
    });
    expect(plan).toEqual([
      { source: "platform_default", countryCode: "US", areaCode: "305", administrativeArea: "FL" },
      { source: "any", countryCode: "US", areaCode: undefined, administrativeArea: undefined }
    ]);
  });

  it("degrades to the bare any-tier when no hints and no env default exist", () => {
    const plan = buildDidSearchPlan({
      preferredAreaCode: null,
      ownerAreaCode: null,
      defaultCountry: "US",
      defaultAreaCode: undefined,
      defaultState: undefined
    });
    expect(plan).toEqual([
      { source: "any", countryCode: "US", areaCode: undefined, administrativeArea: undefined }
    ]);
  });

  it("keeps the default state filter off requested/owner tiers (locale already pinned)", () => {
    const plan = buildDidSearchPlan({
      preferredAreaCode: "480",
      ownerAreaCode: "623",
      defaultCountry: "US",
      defaultAreaCode: "602",
      defaultState: "AZ"
    });
    expect(plan[0].administrativeArea).toBeUndefined();
    expect(plan[1].administrativeArea).toBeUndefined();
    expect(plan[2].administrativeArea).toBe("AZ");
  });
});
