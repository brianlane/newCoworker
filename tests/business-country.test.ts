/**
 * resolveBusinessCountry: the three-way US/CA/MX rule that billing (the
 * country surcharges), provisioning (messaging profile + DID country), and
 * the onboarding order summary all classify from, plus the lockstep
 * agreement with the edge copy (supabase/functions/_shared/
 * business_country.ts) the AiFlow worker uses for bare-digit phone
 * interpretation.
 */
import { describe, expect, it } from "vitest";
import {
  CANADIAN_AREA_CODES,
  CANADIAN_TIMEZONES,
  MEXICAN_TIMEZONES,
  nanpNpaFromPhone,
  resolveBusinessCountry
} from "@/lib/plans/business-country";
import { isCanadianBusiness } from "@/lib/plans/canadian-messaging";
import {
  businessDefaultPhoneCountry,
  MEXICAN_TIMEZONES as EDGE_MEXICAN_TIMEZONES
} from "../supabase/functions/_shared/business_country";

describe("resolveBusinessCountry", () => {
  it("classifies +52 phones as MX, authoritative over any timezone", () => {
    expect(resolveBusinessCountry({ phone: "+525512345678" })).toBe("MX");
    expect(resolveBusinessCountry({ phone: "+52 55 1234 5678", timezone: "America/Toronto" })).toBe(
      "MX"
    );
    expect(resolveBusinessCountry({ phone: "+52 1 55 1234 5678" })).toBe("MX");
  });

  it("classifies plus-less 52/521-prefixed rows as MX (legacy hand entry)", () => {
    expect(resolveBusinessCountry({ phone: "52 55 1234 5678" })).toBe("MX");
    expect(resolveBusinessCountry({ phone: "5215512345678" })).toBe("MX");
  });

  it("never reads a malformed 52-run as MX from the phone alone", () => {
    // Junk +52 (too short), 0-leading national, and a bare 10-digit that
    // merely starts with 52: all fall through to NANP/timezone.
    expect(resolveBusinessCountry({ phone: "+52123" })).toBe("US");
    expect(resolveBusinessCountry({ phone: "+52 05 1234 5678" })).toBe("US");
    expect(resolveBusinessCountry({ phone: "5255123456" })).toBe("US");
  });

  it("classifies NANP phones by NPA and never falls through to timezone", () => {
    expect(resolveBusinessCountry({ phone: "(416) 456-0696" })).toBe("CA");
    expect(resolveBusinessCountry({ phone: "+15198006401" })).toBe("CA");
    expect(
      resolveBusinessCountry({ phone: "(602) 555-0100", timezone: "America/Mexico_City" })
    ).toBe("US");
    expect(resolveBusinessCountry({ phone: "6025550100", timezone: "America/Toronto" })).toBe(
      "US"
    );
  });

  it("falls back to the timezone when the phone is absent or unparseable", () => {
    expect(resolveBusinessCountry({ timezone: "America/Toronto" })).toBe("CA");
    expect(resolveBusinessCountry({ timezone: "America/Mexico_City" })).toBe("MX");
    expect(resolveBusinessCountry({ phone: "+447911123456", timezone: "America/Vancouver" })).toBe(
      "CA"
    );
    expect(resolveBusinessCountry({ phone: "+447911123456", timezone: "America/Cancun" })).toBe(
      "MX"
    );
    expect(resolveBusinessCountry({ timezone: "America/Phoenix" })).toBe("US");
    expect(resolveBusinessCountry({})).toBe("US");
  });

  it("covers every Canadian and Mexican timezone in the sets", () => {
    for (const tz of CANADIAN_TIMEZONES) {
      expect(resolveBusinessCountry({ timezone: tz })).toBe("CA");
    }
    for (const tz of MEXICAN_TIMEZONES) {
      expect(resolveBusinessCountry({ timezone: tz })).toBe("MX");
    }
  });

  it("pins the ONE deliberate delta from pre-Mexico isCanadianBusiness: +52 phone + CA timezone is now MX", () => {
    const input = { phone: "+525512345678", timezone: "America/Toronto" };
    expect(resolveBusinessCountry(input)).toBe("MX");
    expect(isCanadianBusiness(input)).toBe(false);
  });
});

describe("isCanadianBusiness delegation stays behavior-identical", () => {
  // The original truth table: NPA authoritative (a non-CA NANP phone is
  // false WITHOUT consulting timezone), timezone fallback only for
  // non-NANP/absent phones.
  const cases: Array<[{ phone?: string | null; timezone?: string | null }, boolean]> = [
    [{ phone: "4164560696" }, true],
    [{ phone: "1 (519) 800-6401" }, true],
    [{ phone: "+16025550100" }, false],
    [{ phone: "(602) 555-0100", timezone: "America/Toronto" }, false],
    [{ phone: "+447911123456", timezone: "America/Toronto" }, true],
    [{ phone: null, timezone: "America/Vancouver" }, true],
    [{ phone: null, timezone: "America/Phoenix" }, false],
    [{}, false],
    [{ phone: "12345", timezone: "" }, false]
  ];
  it.each(cases)("agrees with the historical semantics for %j", (input, expected) => {
    expect(isCanadianBusiness(input)).toBe(expected);
  });
});

describe("nanpNpaFromPhone", () => {
  it("extracts NPAs from the same shapes canadianNpaFromPhone always accepted", () => {
    expect(nanpNpaFromPhone("4164560696")).toBe("416");
    expect(nanpNpaFromPhone("1 (647) 449-4244")).toBe("647");
    expect(nanpNpaFromPhone("+16028053377")).toBe("602");
    expect(nanpNpaFromPhone("+525512345678")).toBeNull();
    expect(nanpNpaFromPhone("(055) 123-4567")).toBeNull();
    expect(nanpNpaFromPhone("")).toBeNull();
    expect(nanpNpaFromPhone(null)).toBeNull();
  });
});

describe("lockstep with the edge business_country module", () => {
  it("keeps the Mexican timezone sets identical", () => {
    expect([...MEXICAN_TIMEZONES].sort()).toEqual([...EDGE_MEXICAN_TIMEZONES].sort());
  });

  it("agrees on the US/MX collapse across the fixture matrix", () => {
    const phones = [
      undefined,
      null,
      "",
      "+525512345678",
      "+52 1 55 1234 5678",
      "52 55 1234 5678",
      "5215512345678",
      "+52123",
      "+52 05 1234 5678",
      "5255123456",
      "(416) 456-0696",
      "+16028053377",
      "6025550100",
      "+447911123456",
      "12345"
    ];
    const timezones = [
      undefined,
      null,
      "",
      "America/Mexico_City",
      "America/Tijuana",
      "America/Toronto",
      "America/Phoenix",
      "Europe/London"
    ];
    for (const phone of phones) {
      for (const timezone of timezones) {
        const src = resolveBusinessCountry({ phone, timezone });
        const edge = businessDefaultPhoneCountry({ phone, timezone });
        // The edge module collapses CA into "US": both are NANP countries,
        // so bare digits get NANP treatment either way.
        expect(edge).toBe(src === "MX" ? "MX" : "US");
      }
    }
  });
});
