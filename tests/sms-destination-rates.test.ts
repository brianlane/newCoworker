import { describe, expect, it } from "vitest";
import {
  SMS_DIAL_CODES,
  SMS_DESTINATION_MULTIPLIERS,
  SMS_DESTINATION_DENYLIST,
  smsDestinationCountry,
  smsDestinationMultiplier
} from "@/lib/sms/destination-rates";
import {
  SMS_DIAL_CODES as EDGE_DIAL_CODES,
  SMS_DESTINATION_MULTIPLIERS as EDGE_MULTIPLIERS,
  SMS_DESTINATION_DENYLIST as EDGE_DENYLIST,
  smsDestinationCountry as edgeCountry,
  smsDestinationMultiplier as edgeMultiplier
} from "../supabase/functions/_shared/sms_destination_rates";

describe("smsDestinationCountry", () => {
  it("resolves by longest prefix", () => {
    expect(smsDestinationCountry("+16025550100")).toBe("US");
    expect(smsDestinationCountry("+15145188192")).toBe("US");
    // Caribbean +1 territories override the NANP default.
    expect(smsDestinationCountry("+18765550100")).toBe("JM");
    expect(smsDestinationCountry("+18095550100")).toBe("DO");
    expect(smsDestinationCountry("+85261234567")).toBe("HK");
    expect(smsDestinationCountry("+447911123456")).toBe("GB");
    expect(smsDestinationCountry("+4520123456")).toBe("DK");
    expect(smsDestinationCountry("+525512345678")).toBe("MX");
    // +7 splits: Russia default, Kazakhstan on 76/77.
    expect(smsDestinationCountry("+79261234567")).toBe("RU");
    expect(smsDestinationCountry("+77012345678")).toBe("KZ");
  });

  it("returns null for satellite/premium ranges and unparseable input", () => {
    expect(smsDestinationCountry("+8816214567890")).toBeNull();
    expect(smsDestinationCountry("+8825551234")).toBeNull();
    expect(smsDestinationCountry("+9795551234")).toBeNull();
    expect(smsDestinationCountry("6025550100")).toBeNull();
    expect(smsDestinationCountry("")).toBeNull();
    expect(smsDestinationCountry(null)).toBeNull();
  });

  it("tolerates formatting characters", () => {
    expect(smsDestinationCountry("+852 6123 4567")).toBe("HK");
    expect(smsDestinationCountry("+44 (79) 1112-3456")).toBe("GB");
  });
});

describe("smsDestinationMultiplier", () => {
  it("multiplies expensive countries and floors everything else at 1", () => {
    expect(smsDestinationMultiplier("DK")).toBe(18.3);
    expect(smsDestinationMultiplier("GB")).toBe(6.3);
    expect(smsDestinationMultiplier("HK")).toBe(1);
    expect(smsDestinationMultiplier("US")).toBe(1);
    expect(smsDestinationMultiplier(null)).toBe(1);
  });

  it("deliberately excludes MX (the tenant clamp already prices it)", () => {
    expect(SMS_DESTINATION_MULTIPLIERS.MX).toBeUndefined();
    expect(smsDestinationMultiplier("MX")).toBe(1);
  });

  it("keeps every multiplier at least 1 (units can never shrink)", () => {
    for (const v of Object.values(SMS_DESTINATION_MULTIPLIERS)) {
      expect(v).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("denylist", () => {
  it("covers the embargo/toll-fraud set and nothing domestic", () => {
    for (const iso of ["CU", "KP", "SO", "SL", "GN", "GW", "ST"]) {
      expect(SMS_DESTINATION_DENYLIST.has(iso)).toBe(true);
    }
    expect(SMS_DESTINATION_DENYLIST.has("US")).toBe(false);
    expect(SMS_DESTINATION_DENYLIST.has("HK")).toBe(false);
  });
});

describe("edge lockstep copy", () => {
  it("data tables are identical", () => {
    expect(EDGE_DIAL_CODES).toEqual(SMS_DIAL_CODES);
    expect(EDGE_MULTIPLIERS).toEqual(SMS_DESTINATION_MULTIPLIERS);
    expect([...EDGE_DENYLIST].sort()).toEqual([...SMS_DESTINATION_DENYLIST].sort());
  });

  it("functions agree on a fixture matrix", () => {
    const cases = [
      "+16025550100",
      "+18765550100",
      "+85261234567",
      "+4520123456",
      "+8816214567890",
      "+525512345678",
      "bogus",
      ""
    ];
    for (const c of cases) {
      expect(edgeCountry(c)).toBe(smsDestinationCountry(c));
      expect(edgeMultiplier(edgeCountry(c))).toBe(smsDestinationMultiplier(smsDestinationCountry(c)));
    }
    expect(edgeCountry(null)).toBe(smsDestinationCountry(null));
    expect(edgeCountry(undefined)).toBe(smsDestinationCountry(undefined));
  });
});
