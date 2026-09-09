import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

import {
  NANP_BASELINE_CENTS_PER_MINUTE,
  VOICE_ALLOWANCE_SHORT_LEG_SECONDS,
  VOICE_ALLOWANCE_WEIGHT_CAP,
  VOICE_ALLOWANCE_WEIGHT_STORE_MAX,
  applyVoiceAllowanceDurationCap,
  blendedVoiceTerminationRate,
  parseDestinationList,
  telnyxTerminatingLrnFromFields,
  voiceAllowanceRawWeight,
  voiceAllowanceWeight,
  voiceZoneFor
} from "@/lib/plans/voice-zone-rates";
import { ENTERPRISE_UNIT_COSTS } from "@/lib/plans/enterprise-pricing";
import {
  VOICE_RATE_DECK_SHA256,
  VOICE_RATE_ZONES
} from "@/lib/plans/voice-zone-rates.generated";

describe("the generated deck itself", () => {
  it("leaves the enterprise all-in constant at 0.9", () => {
    expect(ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute).toBe(0.9);
  });
  // Assert the PRODUCER, not a fixture: these numbers come off the real
  // deck Telnyx published for 2026-08-31, so a regeneration that silently
  // loses a zone (as an earlier `/^1\d+$/` prefix filter did, dropping both
  // Canada's N11 rows and the NANP catch-all) fails here rather than in
  // production pricing.
  it("carries all 13 zones and the rates read off the deck", () => {
    const byZone = new Map(
      VOICE_RATE_ZONES.map((zone) => [`${zone.iso} ${zone.label}`, zone])
    );
    expect(VOICE_RATE_ZONES).toHaveLength(13);
    expect(byZone.get("US United States 48 (Zone 1)")?.centsPerMinute).toBe(0.5);
    expect(byZone.get("US Hawaii (Zone 2)")?.centsPerMinute).toBe(1);
    expect(byZone.get("US Alaska (Zone 3)")?.centsPerMinute).toBe(7);
    expect(byZone.get("US High Cost (Zone 4)")?.centsPerMinute).toBe(1);
    expect(byZone.get("US High Cost (Zone 5)")?.centsPerMinute).toBe(7);
    expect(byZone.get("US High Cost (Zone 6)")?.centsPerMinute).toBe(18.1);
    expect(byZone.get("US Toll Free")?.centsPerMinute).toBe(0);
    expect(byZone.get("CA Canada (Zone 1)")?.centsPerMinute).toBe(0.5);
    expect(byZone.get("CA Canada (Zone 2)")?.centsPerMinute).toBe(0.9);
    expect(byZone.get("CA Canada (Zone 3)")?.centsPerMinute).toBe(2);
    expect(byZone.get("CA High Cost (Zone 4)")?.centsPerMinute).toBe(6.1);
    expect(byZone.get("CA High Cost (Zone 5)")?.centsPerMinute).toBe(12.1);
    expect(byZone.get("CA N11")?.centsPerMinute).toBe(75);
  });

  it("totals the deck's NANP rows with wildcards expanded", () => {
    // 22,233 deck rows, less the 6 Canadian wildcard rows, plus those 6
    // expanded across Canada's 53 area codes (6 x 53 = 318).
    const total = VOICE_RATE_ZONES.reduce(
      (sum, zone) => sum + zone.prefixes.split(" ").length,
      0
    );
    expect(total).toBe(22_233 - 6 + 318);
  });

  it("leaves no wildcard for the runtime to interpret", () => {
    // An "X" surviving into the table would match any digit at runtime, which
    // is what priced a Phoenix number as Canadian N11 at 75c/min.
    const withX = VOICE_RATE_ZONES.flatMap((zone) =>
      zone.prefixes.split(" ").filter((prefix) => !/^1\d*$/.test(prefix))
    );
    expect(withX).toEqual([]);
  });

  it("keeps the NANP catch-all, without which no unlisted number prices", () => {
    const zone1 = VOICE_RATE_ZONES.find(
      (z) => z.iso === "US" && z.label === "United States 48 (Zone 1)"
    );
    expect(zone1?.prefixes.split(" ")).toContain("1");
  });

  it("records the sha256 of the deck it was generated from", () => {
    expect(VOICE_RATE_DECK_SHA256).toBe(
      "16f61dc814f33a5270b7afb8ec6a609b01d836c8ca4e95bc2ccec931edef5d68"
    );
  });
});

describe("number normalization, through the public lookup", () => {
  it("accepts the shapes a stored number actually arrives in", () => {
    // All four are the same Phoenix number; all four must price identically.
    for (const form of ["+16028384497", "16028384497", "(602) 838-4497", "6028384497"]) {
      expect(voiceZoneFor(form)?.centsPerMinute).toBe(0.5);
    }
  });

  it("declines empty, missing and non-NANP input rather than guessing", () => {
    expect(voiceZoneFor(null)).toBeNull();
    expect(voiceZoneFor(undefined)).toBeNull();
    expect(voiceZoneFor("")).toBeNull();
    // A UK mobile: 11 digits after stripping, but not a NANP 1.
    expect(voiceZoneFor("+447700900123")).toBeNull();
    // 11 digits that do not start with 1.
    expect(voiceZoneFor("20123456789")).toBeNull();
    expect(voiceZoneFor("12345")).toBeNull();
  });
});

describe("voiceZoneFor", () => {
  it("prefers the 7 digit NPA-NXX row over the NPA it sits inside", () => {
    // +1 480 xxx is Arizona, priced at the lower-48 baseline...
    expect(voiceZoneFor("+14805551234")).toMatchObject({
      iso: "US",
      label: "United States 48 (Zone 1)",
      centsPerMinute: 0.5
    });
    // ...but 480-306 is carved out as Zone 4 at twice the rate, and the
    // longer row has to win or the carve-out is invisible.
    const zone4 = voiceZoneFor("+14803065555");
    expect(zone4?.label).toBe("High Cost (Zone 4)");
    expect(zone4?.centsPerMinute).toBe(1);
    expect(zone4?.matchedPrefix).toBe("1480306");
  });

  it("prices the expensive rural zones that motivated the table", () => {
    // 605 South Dakota has 243 high-cost prefixes, the densest in the deck.
    const zone5 = voiceZoneFor("+16055235555");
    expect(zone5?.label).toBe("High Cost (Zone 5)");
    expect(zone5?.centsPerMinute).toBe(7);
    expect(zone5?.centsPerMinute).toBe(14 * NANP_BASELINE_CENTS_PER_MINUTE);
  });

  it("falls back to the catch-all for an unlisted NANP number", () => {
    // 999 is not an assigned NPA, so nothing but the bare "1" can match it.
    const hit = voiceZoneFor("+19995551234");
    expect(hit?.matchedPrefix).toBe("1");
    expect(hit?.centsPerMinute).toBe(NANP_BASELINE_CENTS_PER_MINUTE);
  });

  it("matches Canada's N11 service codes inside CANADIAN area codes", () => {
    // "1XXX311" in the deck: any Canadian area code, service code 311.
    // 416 is Toronto, so this one is genuinely N11.
    const n11 = voiceZoneFor("+14163110000");
    expect(n11?.iso).toBe("CA");
    expect(n11?.label).toBe("N11");
    expect(n11?.centsPerMinute).toBe(75);
    expect(voiceZoneFor("+14163100000")?.label).toBe("N11");
  });

  it("does not price a US number as Canadian N11", () => {
    // THE REGRESSION. Compiled as "any three digits", the deck's 1XXX310 row
    // won at length 7 against every NANP number with a 310 or N11 exchange.
    // +1 602 310 0000 is Phoenix and priced at 75c/min instead of 0.5c, 150x
    // too expensive, and one such contact drags a whole deal blend with it.
    for (const usNumber of ["+16023100000", "+16023110000", "+12133105555"]) {
      const zone = voiceZoneFor(usNumber);
      expect(zone?.iso).toBe("US");
      expect(zone?.label).not.toBe("N11");
      expect(zone?.centsPerMinute).toBe(0.5);
    }
  });

  it("does not let a service code swallow an ordinary Canadian number", () => {
    const ordinary = voiceZoneFor("+14165551234");
    expect(ordinary?.label).not.toBe("N11");
  });

  it("returns null for a non-NANP destination rather than guessing", () => {
    expect(voiceZoneFor("+447700900123")).toBeNull();
    expect(voiceZoneFor(null)).toBeNull();
  });

  it("memoises the index across calls", () => {
    const first = voiceZoneFor("+16028384497");
    const second = voiceZoneFor("+16028384497");
    expect(first).toEqual(second);
    expect(first?.matchedOn).toBe("dialed");
  });
});

describe("LRN-preferred matching", () => {
  it("charges Zone 5 when dialed is Zone 1 but LRN is Payson high-cost", () => {
    // Amy Sep 2026 MDR: dialed +19289512316 (Payson AZ) is `1928` Zone 1
    // @ 0.5c. Telnyx billed Terminating LRN 9283630020 as `1928363` High
    // Cost Zone 5 @ 7c. Matching dialed-only is what made auto-cutover
    // PR #1809 look like a Zone 1 list-price change; it was closed.
    const dialed = voiceZoneFor("+19289512316");
    expect(dialed).toMatchObject({
      label: "United States 48 (Zone 1)",
      centsPerMinute: 0.5,
      matchedPrefix: "1928",
      matchedOn: "dialed"
    });
    const billed = voiceZoneFor("+19289512316", { lrn: "9283630020" });
    expect(billed).toMatchObject({
      iso: "US",
      label: "High Cost (Zone 5)",
      centsPerMinute: 7,
      matchedPrefix: "1928363",
      matchedOn: "lrn"
    });
    expect(voiceZoneFor({ dialed: "+19289512316", lrn: "+19283630020" })).toEqual(
      billed
    );
  });

  it("accepts a Telnyx term prefix when that is all the MDR gives", () => {
    const billed = voiceZoneFor("+19289512316", { lrn: "1928363" });
    expect(billed?.label).toBe("High Cost (Zone 5)");
    expect(billed?.matchedPrefix).toBe("1928363");
    expect(billed?.matchedOn).toBe("lrn");
  });

  it("keeps dialed Zone 1 when no LRN is available", () => {
    expect(voiceZoneFor("+19289512316")?.centsPerMinute).toBe(0.5);
    expect(voiceZoneFor("+19289512316", { lrn: null })?.matchedOn).toBe("dialed");
    expect(voiceZoneFor("+19289512316", { lrn: "" })?.matchedOn).toBe("dialed");
    expect(voiceZoneFor("+19289512316", { lrn: "not-a-number" })?.matchedOn).toBe(
      "dialed"
    );
    expect(voiceZoneFor({ dialed: "+19289512316" })?.matchedOn).toBe("dialed");
    expect(voiceZoneFor()).toBeNull();
  });

  it("prices the 504 dialed-Zone-1 / LRN-Zone-4 pattern", () => {
    // Same MDR pattern as Payson: +15044628344 is NPA 504 Zone 1 on the
    // dialed number; a 504-401 LRN is High Cost Zone 4 @ 1c.
    expect(voiceZoneFor("+15044628344")).toMatchObject({
      label: "United States 48 (Zone 1)",
      centsPerMinute: 0.5,
      matchedPrefix: "1504",
      matchedOn: "dialed"
    });
    expect(voiceZoneFor("+15044628344", { lrn: "5044010000" })).toMatchObject({
      label: "High Cost (Zone 4)",
      centsPerMinute: 1,
      matchedPrefix: "1504401",
      matchedOn: "lrn"
    });
  });

  it("leaves Canada unchanged when the LRN already matches the dialed zone", () => {
    const dialed = voiceZoneFor("+14165551234");
    const withLrn = voiceZoneFor("+14165551234", { lrn: "4165551234" });
    expect(dialed?.iso).toBe("CA");
    expect(dialed?.label).not.toBe("N11");
    expect(withLrn?.iso).toBe(dialed?.iso);
    expect(withLrn?.label).toBe(dialed?.label);
    expect(withLrn?.centsPerMinute).toBe(dialed?.centsPerMinute);
    expect(withLrn?.matchedPrefix).toBe(dialed?.matchedPrefix);
    expect(withLrn?.matchedOn).toBe("lrn");

    const n11 = voiceZoneFor("+14163110000", { lrn: "4163110000" });
    expect(n11?.iso).toBe("CA");
    expect(n11?.label).toBe("N11");
    expect(n11?.centsPerMinute).toBe(75);
  });

  it("prices LRN alone when no dialed number is supplied", () => {
    expect(voiceZoneFor(null, { lrn: "9283630020" })?.label).toBe("High Cost (Zone 5)");
    expect(voiceZoneFor({ lrn: "1928363" })?.centsPerMinute).toBe(7);
  });

  it("does not let a non-NANP LRN override a good dialed number", () => {
    const zone = voiceZoneFor("+19289512316", { lrn: "+447700900123" });
    expect(zone?.matchedOn).toBe("dialed");
    expect(zone?.centsPerMinute).toBe(0.5);
  });
});

describe("telnyxTerminatingLrnFromFields", () => {
  it("reads portal CSV and API keys, first usable key wins", () => {
    expect(telnyxTerminatingLrnFromFields(null)).toBeNull();
    expect(telnyxTerminatingLrnFromFields({})).toBeNull();
    expect(
      telnyxTerminatingLrnFromFields({ "Terminating LRN": "9283630020" })
    ).toBe("9283630020");
    expect(telnyxTerminatingLrnFromFields({ terminating_lrn: "9283630020" })).toBe(
      "9283630020"
    );
    expect(telnyxTerminatingLrnFromFields({ "Term Prefix": "1928363" })).toBe(
      "1928363"
    );
    expect(
      telnyxTerminatingLrnFromFields({
        terminating_lrn: "9283630020",
        "Term Prefix": "1928"
      })
    ).toBe("9283630020");
    expect(
      telnyxTerminatingLrnFromFields({ terminating_lrn: "  ", lrn: "5044010000" })
    ).toBe("5044010000");
    expect(telnyxTerminatingLrnFromFields({ terminating_lrn: 9283630020 })).toBe(
      "9283630020"
    );
    expect(telnyxTerminatingLrnFromFields({ lrn: "+447700900123" })).toBeNull();
    expect(telnyxTerminatingLrnFromFields({ lrn: Number.POSITIVE_INFINITY })).toBeNull();
    expect(telnyxTerminatingLrnFromFields({ lrn: true })).toBeNull();
  });
});

describe("blendedVoiceTerminationRate", () => {
  it("averages only what it could price and counts what it could not", () => {
    const blend = blendedVoiceTerminationRate([
      "+14805551234", // Zone 1, 0.5c
      "+16055235555", // Zone 5, 7c
      "+447700900123" // not NANP, excluded
    ]);
    expect(blend.priced).toBe(2);
    expect(blend.unpriced).toBe(1);
    expect(blend.centsPerMinute).toBe(3.75);
  });

  it("excludes rather than folds unpriceable numbers in at the baseline", () => {
    // Folding the unpriced one in at 0.5c would report 2.5c, understating
    // a list that is genuinely 3.75c across what we can actually price.
    const blend = blendedVoiceTerminationRate([
      "+14805551234",
      "+16055235555",
      "+447700900123"
    ]);
    expect(blend.centsPerMinute).not.toBe(2.5);
  });

  it("falls back to the baseline, and says so, when nothing prices", () => {
    const blend = blendedVoiceTerminationRate(["+447700900123", null, undefined]);
    expect(blend.priced).toBe(0);
    expect(blend.unpriced).toBe(3);
    expect(blend.centsPerMinute).toBe(NANP_BASELINE_CENTS_PER_MINUTE);
  });

  it("handles an empty list", () => {
    const blend = blendedVoiceTerminationRate([]);
    expect(blend.priced).toBe(0);
    expect(blend.centsPerMinute).toBe(NANP_BASELINE_CENTS_PER_MINUTE);
  });

  it("rounds to 4 decimal places of a cent", () => {
    // Three 1c Zone 4 numbers and one 0.5c baseline average to 0.875.
    const blend = blendedVoiceTerminationRate([
      "+14803065555",
      "+14803062222",
      "+14803063333",
      "+14805551234"
    ]);
    expect(blend.centsPerMinute).toBe(0.875);
  });

  it("prefers LRN on mixed destinations and keeps dialed-only strings cheap", () => {
    const withLrn = blendedVoiceTerminationRate([
      { dialed: "+19289512316", lrn: "9283630020" },
      "+14805551234"
    ]);
    expect(withLrn.priced).toBe(2);
    expect(withLrn.centsPerMinute).toBe(3.75);
    expect(withLrn.priciestZone?.label).toBe("High Cost (Zone 5)");

    const dialedOnly = blendedVoiceTerminationRate(["+19289512316", "+14805551234"]);
    expect(dialedOnly.centsPerMinute).toBe(0.5);
    expect(dialedOnly.priciestZone?.label).toBe("United States 48 (Zone 1)");
  });
});

describe("a deck with no catch-all", () => {
  afterEach(() => {
    vi.doUnmock("../supabase/functions/_shared/voice-zone-rates.generated.ts");
    vi.resetModules();
  });

  // The live deck's bare "1" row means every NANP number resolves, so the
  // "matched nothing" path is unreachable with real data. It is still the
  // correct behaviour if a future deck ever drops the catch-all, and an
  // untested fallthrough is where a silent 0 would hide.
  it("returns null instead of inventing a rate", async () => {
    vi.resetModules();
    vi.doMock("../supabase/functions/_shared/voice-zone-rates.generated.ts", () => ({
      VOICE_RATE_DECK_SHA256: "deadbeef",
      VOICE_RATE_ZONES: [
        {
          iso: "US",
          label: "United States 48 (Zone 1)",
          centsPerMinute: 0.5,
          prefixes: "1602 1XXX311"
        }
      ]
    }));
    // A fresh import gives a fresh module scope, so the memoised index is
    // rebuilt from the mock without needing a reset seam in production code.
    const mod = await import("../supabase/functions/_shared/voice_zone_rates");

    expect(mod.voiceZoneFor("+16025551234")?.matchedPrefix).toBe("1602");
    expect(mod.voiceZoneFor("+16025551234")?.matchedOn).toBe("dialed");
    // 480 is absent and there is no catch-all behind it.
    expect(mod.voiceZoneFor("+14805551234")).toBeNull();
    // A parseable LRN that misses the table must not fall back to dialed.
    expect(mod.voiceZoneFor("+16025551234", { lrn: "14805551234" })).toBeNull();
    expect(mod.voiceZoneFor("+14805551234", { lrn: "16025550000" })?.matchedOn).toBe(
      "lrn"
    );
    // A parseable LRN that misses the table must not invent a weight.
    expect(mod.voiceAllowanceWeight(null, { lrn: "14805551234" })).toBe(1);
  });
});

describe("parseDestinationList", () => {
  it("keeps a formatted number whole instead of shredding it", () => {
    // THE REGRESSION. Splitting on every non-digit turned "(602) 838-4497"
    // into "602", "838", "4497", none of which is an NANP number, so the
    // blend priced nothing, fell back to baseline, and a pasted rural list
    // was silently quoted as lower-48 traffic.
    expect(parseDestinationList("(602) 838-4497")).toEqual(["(602) 838-4497"]);
    expect(voiceZoneFor(parseDestinationList("(602) 838-4497")[0])).not.toBeNull();
  });

  it("splits the separators between entries", () => {
    expect(parseDestinationList("+16028384497\n+16055235555")).toEqual([
      "+16028384497",
      "+16055235555"
    ]);
    expect(parseDestinationList("(602) 838-4497, +1 605 523 5555")).toEqual([
      "(602) 838-4497",
      "+1 605 523 5555"
    ]);
    expect(parseDestinationList("+16028384497;\t+16055235555")).toEqual([
      "+16028384497",
      "+16055235555"
    ]);
  });

  it("splits space-separated numbers only when every piece is valid", () => {
    expect(parseDestinationList("+16028384497 +16055235555")).toEqual([
      "+16028384497",
      "+16055235555"
    ]);
    // "602 838 4497" is ONE number written with spaces, not three numbers.
    expect(parseDestinationList("602 838 4497")).toEqual(["602 838 4497"]);
  });

  it("passes an unparseable entry through so it shows as unpriced", () => {
    // Dropping it would hide the problem; counting it makes it visible.
    const parsed = parseDestinationList("not a phone number\n+16028384497");
    expect(parsed).toContain("not a phone number");
    expect(blendedVoiceTerminationRate(parsed).unpriced).toBe(1);
  });

  it("ignores blank entries and surrounding whitespace", () => {
    expect(parseDestinationList("\n\n  +16028384497  ,,\n")).toEqual(["+16028384497"]);
    expect(parseDestinationList("")).toEqual([]);
  });

  it("prices a pasted rural list as rural, end to end", () => {
    const blend = blendedVoiceTerminationRate(
      parseDestinationList("(605) 523-5555, (602) 838-4497")
    );
    expect(blend.priced).toBe(2);
    expect(blend.centsPerMinute).toBe(3.75);
    expect(blend.priciestZone?.label).toBe("High Cost (Zone 5)");
  });
});

describe("voiceAllowanceWeight", () => {
  it("is 1x for Zone 1 LRN, missing LRN, and dialed-only", () => {
    expect(voiceAllowanceWeight(null, { lrn: "6028384497" })).toBe(1);
    expect(voiceAllowanceWeight("+19289512316")).toBe(1);
    expect(voiceAllowanceWeight("+19289512316", { lrn: null })).toBe(1);
    expect(voiceAllowanceWeight("+19289512316", { lrn: "" })).toBe(1);
    expect(voiceAllowanceWeight(null)).toBe(1);
    expect(voiceAllowanceWeight("+19289512316", { lrn: "+447700900123" })).toBe(1);
    expect(
      voiceAllowanceWeight(null, { billableSeconds: 120 })
    ).toBe(1);
    expect(voiceAllowanceRawWeight(null, { lrn: null })).toBe(1);
  });

  it("is 14x for Payson Zone 5 LRN and 2x for Zone 4", () => {
    expect(voiceAllowanceWeight("+19289512316", { lrn: "9283630020" })).toBe(14);
    expect(voiceAllowanceWeight({ lrn: "1928363" })).toBe(14);
    expect(voiceAllowanceWeight(null, { lrn: "5044010000" })).toBe(2);
  });

  it("does not stack a second ceil on the already-billed minute", () => {
    // Settlement ceils 33s to 60 first. Weight multiplies that 60.
    // ceil(33 * 14) = 462 would be the double-ceil bug.
    const weight = voiceAllowanceWeight(null, { lrn: "9283630020" });
    expect(Math.round(60 * weight)).toBe(840);
    expect(Math.ceil(33 * weight)).toBe(462);
  });

  it("caps Zone 6 and Canada N11 on a short billed minute, full raw when longer", () => {
    expect(VOICE_ALLOWANCE_WEIGHT_CAP).toBe(20);
    expect(VOICE_ALLOWANCE_SHORT_LEG_SECONDS).toBe(60);
    expect(VOICE_ALLOWANCE_WEIGHT_STORE_MAX).toBe(200);
    const n11 = voiceZoneFor("+14163110000", { lrn: "4163110000" });
    expect(n11?.centsPerMinute).toBe(75);
    expect(75 / NANP_BASELINE_CENTS_PER_MINUTE).toBe(150);
    expect(voiceAllowanceRawWeight(null, { lrn: "4163110000" })).toBe(150);
    expect(voiceAllowanceWeight(null, { lrn: "4163110000" })).toBe(20);
    expect(
      voiceAllowanceWeight(null, { lrn: "4163110000", billableSeconds: 60 })
    ).toBe(20);
    expect(
      voiceAllowanceWeight(null, { lrn: "4163110000", billableSeconds: 120 })
    ).toBe(150);

    const zone6 = VOICE_RATE_ZONES.find(
      (z) => z.iso === "US" && z.label === "High Cost (Zone 6)"
    );
    expect(zone6).toBeDefined();
    const prefix = zone6!.prefixes.split(" ").find((p) => p.length >= 7);
    expect(prefix).toBeTruthy();
    const raw = 18.1 / NANP_BASELINE_CENTS_PER_MINUTE;
    expect(raw).toBeGreaterThan(VOICE_ALLOWANCE_WEIGHT_CAP);
    expect(voiceAllowanceRawWeight(null, { lrn: prefix })).toBe(raw);
    expect(voiceAllowanceWeight(null, { lrn: prefix })).toBe(20);
    expect(voiceAllowanceWeight(null, { lrn: prefix, billableSeconds: null })).toBe(
      20
    );
    expect(voiceAllowanceWeight(null, { lrn: prefix, billableSeconds: 61 })).toBe(
      raw
    );
    expect(Math.round(120 * raw)).toBe(4344);
  });

  it("duration-gates a raw multiplier without a hybrid first-minute split", () => {
    expect(applyVoiceAllowanceDurationCap(36.2, 33)).toBe(20);
    expect(applyVoiceAllowanceDurationCap(36.2, 60)).toBe(20);
    expect(applyVoiceAllowanceDurationCap(36.2, 61)).toBe(36.2);
    expect(applyVoiceAllowanceDurationCap(36.2, 120)).toBe(36.2);
    expect(applyVoiceAllowanceDurationCap(14, 33)).toBe(14);
    expect(applyVoiceAllowanceDurationCap(14, 120)).toBe(14);
    expect(applyVoiceAllowanceDurationCap(1, 120)).toBe(1);
    expect(applyVoiceAllowanceDurationCap(0, 120)).toBe(1);
    expect(applyVoiceAllowanceDurationCap(9999, 120)).toBe(200);
    expect(applyVoiceAllowanceDurationCap(150, undefined)).toBe(20);
  });

  it("treats toll-free 0c as 1x rather than free minutes", () => {
    const tollFree = VOICE_RATE_ZONES.find((z) => z.label === "Toll Free");
    const prefix = tollFree?.prefixes.split(" ")[0];
    expect(prefix).toBeTruthy();
    expect(voiceAllowanceWeight(null, { lrn: prefix })).toBe(1);
  });
});

describe("edge lockstep copy", () => {
  it("keeps the generated decks byte-identical", () => {
    const src = readFileSync(
      join(repoRoot, "src/lib/plans/voice-zone-rates.generated.ts"),
      "utf8"
    );
    const edge = readFileSync(
      join(repoRoot, "supabase/functions/_shared/voice-zone-rates.generated.ts"),
      "utf8"
    );
    expect(edge).toBe(src);
  });

  it("agrees with src on LRN weight fixtures", async () => {
    const edge = await import("../supabase/functions/_shared/voice_zone_rates");
    const cases: Array<{ dialed?: string; lrn?: string | null }> = [
      { dialed: "+19289512316" },
      { dialed: "+19289512316", lrn: "9283630020" },
      { lrn: "1928363" },
      { dialed: "+15044628344", lrn: "5044010000" },
      { lrn: "4163110000" },
      { lrn: null },
      { dialed: "+16028384497", lrn: "+447700900123" }
    ];
    for (const c of cases) {
      expect(edge.voiceAllowanceWeight(c.dialed, { lrn: c.lrn })).toBe(
        voiceAllowanceWeight(c.dialed, { lrn: c.lrn })
      );
      expect(edge.voiceZoneFor(c.dialed, { lrn: c.lrn })).toEqual(
        voiceZoneFor(c.dialed, { lrn: c.lrn })
      );
      expect(edge.telnyxTerminatingLrnFromFields({ terminating_lrn: c.lrn })).toBe(
        telnyxTerminatingLrnFromFields({ terminating_lrn: c.lrn })
      );
    }
    expect(edge.VOICE_ALLOWANCE_WEIGHT_CAP).toBe(VOICE_ALLOWANCE_WEIGHT_CAP);
    expect(edge.VOICE_ALLOWANCE_SHORT_LEG_SECONDS).toBe(
      VOICE_ALLOWANCE_SHORT_LEG_SECONDS
    );
    expect(edge.VOICE_ALLOWANCE_WEIGHT_STORE_MAX).toBe(
      VOICE_ALLOWANCE_WEIGHT_STORE_MAX
    );
    expect(edge.NANP_BASELINE_CENTS_PER_MINUTE).toBe(NANP_BASELINE_CENTS_PER_MINUTE);
    expect(edge.voiceAllowanceRawWeight(null, { lrn: "4163110000" })).toBe(150);
    expect(edge.applyVoiceAllowanceDurationCap(36.2, 60)).toBe(20);
    expect(edge.applyVoiceAllowanceDurationCap(36.2, 120)).toBe(36.2);
  });
});

