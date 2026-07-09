import { describe, expect, it } from "vitest";
import {
  CANADA_MESSAGING_FEE_MONTHLY_CENTS,
  CANADA_MESSAGING_FEE_NAME,
  CANADIAN_AREA_CODES,
  CANADIAN_TIMEZONES,
  canadianNpaFromPhone,
  isCanadianBusiness
} from "@/lib/plans/canadian-messaging";

describe("canadianNpaFromPhone", () => {
  it("extracts the NPA from free-form NANP inputs (bare 10, 1-prefixed 11, +1)", () => {
    expect(canadianNpaFromPhone("4164560696")).toBe("416");
    expect(canadianNpaFromPhone("1 (647) 449-4244")).toBe("647");
    expect(canadianNpaFromPhone("+15198006401")).toBe("519");
  });
  it("returns null for non-NANP, malformed, or empty input", () => {
    expect(canadianNpaFromPhone("+447911123456")).toBeNull(); // UK
    expect(canadianNpaFromPhone("12345")).toBeNull();
    expect(canadianNpaFromPhone("")).toBeNull();
    expect(canadianNpaFromPhone("   ")).toBeNull();
    expect(canadianNpaFromPhone(null)).toBeNull();
    expect(canadianNpaFromPhone(undefined)).toBeNull();
    expect(canadianNpaFromPhone("no-digits!")).toBeNull();
  });
  it("rejects an NPA that can't exist (leading 0/1)", () => {
    // +1 followed by 10 digits whose NPA starts with 1 — structurally NANP
    // but not a real area code.
    expect(canadianNpaFromPhone("+11234567890")).toBeNull();
  });
});

describe("isCanadianBusiness", () => {
  it("is true for Canadian area codes and false for US ones (phone is authoritative)", () => {
    expect(isCanadianBusiness({ phone: "4164560696" })).toBe(true); // Toronto
    expect(isCanadianBusiness({ phone: "+15198006401" })).toBe(true); // Ontario
    expect(isCanadianBusiness({ phone: "6025551234" })).toBe(false); // Phoenix
    // A US phone wins over a Canadian timezone — the phone drives which
    // country the coworker number is purchased in.
    expect(
      isCanadianBusiness({ phone: "6025551234", timezone: "America/Toronto" })
    ).toBe(false);
  });
  it("falls back to the timezone only when the phone isn't NANP", () => {
    expect(isCanadianBusiness({ phone: "+447911123456", timezone: "America/Toronto" })).toBe(true);
    expect(isCanadianBusiness({ timezone: "America/Vancouver" })).toBe(true);
    expect(isCanadianBusiness({ timezone: "America/Phoenix" })).toBe(false);
    expect(isCanadianBusiness({ timezone: "  " })).toBe(false);
    expect(isCanadianBusiness({})).toBe(false);
  });
});

describe("constants", () => {
  it("fee is $4.99/mo with a customer-facing label", () => {
    expect(CANADA_MESSAGING_FEE_MONTHLY_CENTS).toBe(499);
    expect(CANADA_MESSAGING_FEE_NAME).toBe("Canadian messaging surcharge");
  });
  it("area codes are 3-digit NPAs and timezones are Canadian IANA zones", () => {
    for (const npa of CANADIAN_AREA_CODES) expect(npa).toMatch(/^[2-9]\d{2}$/);
    for (const tz of CANADIAN_TIMEZONES) expect(tz).toMatch(/^America\//);
    // Spot-check the majors so a bulk edit can't silently drop them.
    for (const npa of ["416", "647", "519", "905", "514", "604", "403"]) {
      expect(CANADIAN_AREA_CODES.has(npa)).toBe(true);
    }
    expect(CANADIAN_TIMEZONES.has("America/Toronto")).toBe(true);
  });
});
