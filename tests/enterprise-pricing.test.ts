import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE,
  TELNYX_TPT_COMBINED_RATE,
  TELNYX_MESSAGING_INTRASTATE_SHARE,
  estimateTelnyxTaxCents,
  VOICE_ALL_IN_CENTS_PER_MINUTE,
  DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS,
  estimateEnterpriseMonthlyCost,
  suggestEnterprisePrice
} from "@/lib/plans/enterprise-pricing";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";

describe("estimateEnterpriseMonthlyCost", () => {
  it("adds no zone surcharge, and no line, when no destinations are given", () => {
    // The whole point of the option being optional: an existing caller must
    // get byte-for-byte the estimate it got before the zone table existed.
    const est = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm2",
      smsPerMonth: 100,
      voiceMinutesPerMonth: 500
    });
    expect(est.items.some((i) => i.label.startsWith("Voice high-cost zones"))).toBe(false);
  });

  it("adds no zone surcharge for an all-lower-48 destination list", () => {
    const withList = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm2",
      smsPerMonth: 100,
      voiceMinutesPerMonth: 500,
      voiceDestinations: ["+14805551234", "+16025551234"]
    });
    const without = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm2",
      smsPerMonth: 100,
      voiceMinutesPerMonth: 500
    });
    expect(withList.totalCents).toBe(without.totalCents);
    expect(withList.items.some((i) => i.label.startsWith("Voice high-cost zones"))).toBe(
      false
    );
  });

  it("charges only the INCREMENT above baseline on a rural list", () => {
    // Half lower-48 (0.5c), half South Dakota Zone 5 (7c) blends to 3.75c.
    // The surcharge is the 3.25c ABOVE the 0.5c baseline that
    // voiceTelnyxCentsPerMinute already contains, never the full 3.75c:
    // charging the full rate would bill Zone 1 termination twice.
    const est = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm2",
      smsPerMonth: 100,
      voiceMinutesPerMonth: 500,
      voiceDestinations: ["+14805551234", "+16055235555"]
    });
    const surcharge = est.items.find((i) => i.label.startsWith("Voice high-cost zones"));
    expect(surcharge?.cents).toBe(500 * 3.25);
    expect(surcharge?.label).toContain("3.75c/min");
    expect(surcharge?.label).toContain("2 destinations");
    // Naming the worst zone is the point: a blend alone cannot tell an
    // operator whether one number or all of them is the problem.
    expect(surcharge?.label).toContain("priciest US High Cost (Zone 5) at 7c");
  });

  it("puts the surcharge before the tax line and taxes it as voice", () => {
    const base = {
      vpsSize: "kvm2" as const,
      smsPerMonth: 100,
      voiceMinutesPerMonth: 500
    };
    const est = estimateEnterpriseMonthlyCost({
      ...base,
      voiceDestinations: ["+16055235555"]
    });
    expect(est.items[est.items.length - 1].label).toBe("Telnyx taxes (est.)");
    // A surcharge that is voice usage must move the tax line, or the tax
    // model is silently ignoring a Telnyx charge.
    const taxWith = est.items[est.items.length - 1].cents;
    const taxWithout =
      estimateEnterpriseMonthlyCost(base).items.at(-1)?.cents ?? 0;
    expect(taxWith).toBeGreaterThan(taxWithout);
  });

  it("uses the singular for a one-destination list", () => {
    const est = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm2",
      smsPerMonth: 100,
      voiceMinutesPerMonth: 10,
      voiceDestinations: ["+16055235555"]
    });
    expect(
      est.items.find((i) => i.label.startsWith("Voice high-cost zones"))?.label
    ).toContain("1 destination,");
  });

  it("itemizes hosting + SMS + voice + DID and totals them", () => {
    const est = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm8",
      smsPerMonth: 1000,
      voiceMinutesPerMonth: 500,
      extraDids: 2
    });

    const smsCents = 1000 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage; // 1590
    const didCents = 3 * ENTERPRISE_UNIT_COSTS.didMonthlyCents; // 330
    // Tax hits the Telnyx share only: SMS + the Telnyx voice component at
    // the usage rate, DID MRCs at the MRC rate. Gemini's share is untaxed.
    const taxCents = estimateTelnyxTaxCents({
      recurringCents: didCents,
      voiceUsageCents: 500 * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute,
      messagingUsageCents: smsCents
    });
    const expected =
      HOSTING_MONTHLY_CENTS_BY_SIZE.kvm8 + // 7399
      smsCents +
      500 * VOICE_ALL_IN_CENTS_PER_MINUTE + // 1575
      didCents +
      taxCents; // 112.272

    expect(est.items).toHaveLength(5);
    expect(est.totalCents).toBe(Math.round(expected));
  });

  it("defaults extraDids to 0 (one included DID)", () => {
    const est = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm2",
      smsPerMonth: 0,
      voiceMinutesPerMonth: 0
    });
    expect(est.totalCents).toBe(
      Math.round(
        HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2 +
          ENTERPRISE_UNIT_COSTS.didMonthlyCents * (1 + TELNYX_TPT_COMBINED_RATE)
      )
    );
  });

  it("rejects negative or non-finite usage", () => {
    expect(() =>
      estimateEnterpriseMonthlyCost({ vpsSize: "kvm8", smsPerMonth: -1, voiceMinutesPerMonth: 0 })
    ).toThrow(/smsPerMonth/);
    expect(() =>
      estimateEnterpriseMonthlyCost({
        vpsSize: "kvm8",
        smsPerMonth: 0,
        voiceMinutesPerMonth: Number.NaN
      })
    ).toThrow(/voiceMinutesPerMonth/);
    expect(() =>
      estimateEnterpriseMonthlyCost({
        vpsSize: "kvm8",
        smsPerMonth: 0,
        voiceMinutesPerMonth: 0,
        extraDids: -2
      })
    ).toThrow(/extraDids/);
  });
});

describe("suggestEnterprisePrice", () => {
  it("solves the monthly price so the target margin holds after Stripe fees", () => {
    const cost = 10_000; // $100/mo cost
    const s = suggestEnterprisePrice(cost, 60);

    // P >= (cost + fixed) / (1 - 2.9% - 60%), rounded up to $5.
    const rawMonthly = (cost + 30) / (1 - 0.029 - 0.6);
    expect(s.monthlyCents).toBe(Math.ceil(rawMonthly / 500) * 500);
    expect(s.monthlyCents % 500).toBe(0);

    // At the suggested price, the realized net margin meets or beats target.
    const net = s.monthlyCents * (1 - 0.029) - 30 - cost;
    expect(s.monthlyNetMarginCents).toBe(Math.round(net));
    expect(net).toBeGreaterThanOrEqual(0.6 * s.monthlyCents);
  });

  it("grosses the setup fee up so labor + carrier fee survive Stripe's cut", () => {
    const s = suggestEnterprisePrice(0, 0);
    const rawSetup =
      (DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS + CARRIER_REGISTRATION_FEE_CENTS + 30) / (1 - 0.029);
    expect(s.setupCents).toBe(Math.ceil(rawSetup / 500) * 500);
    // Net of Stripe fees the setup covers its inputs.
    expect(s.setupCents * (1 - 0.029) - 30).toBeGreaterThanOrEqual(
      DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS + CARRIER_REGISTRATION_FEE_CENTS
    );
  });

  it("honors a custom setup-labor input", () => {
    const cheap = suggestEnterprisePrice(10_000, 50, 0);
    const pricey = suggestEnterprisePrice(10_000, 50, 200_000);
    expect(pricey.setupCents).toBeGreaterThan(cheap.setupCents);
    expect(pricey.monthlyCents).toBe(cheap.monthlyCents);
  });

  it("rejects out-of-range margins and negative inputs", () => {
    expect(() => suggestEnterprisePrice(10_000, -1)).toThrow(/targetMarginPct/);
    expect(() => suggestEnterprisePrice(10_000, 91)).toThrow(/targetMarginPct/);
    expect(() => suggestEnterprisePrice(-1, 50)).toThrow(/monthlyCostCents/);
    expect(() => suggestEnterprisePrice(10_000, 50, -5)).toThrow(/setupLaborCents/);
  });
});

describe("estimateTelnyxTaxCents", () => {
  it("taxes recurring and voice in full, messaging only on its intrastate share", () => {
    expect(
      estimateTelnyxTaxCents({
        recurringCents: 1000,
        voiceUsageCents: 100,
        messagingUsageCents: 10_000
      })
    ).toBe(
      Math.round(
        (1000 + 100 + 10_000 * TELNYX_MESSAGING_INTRASTATE_SHARE) * TELNYX_TPT_COMBINED_RATE
      )
    );
  });

  it("reproduces the July 2026 invoice's sales tax to the cent", () => {
    // Invoice #0004: numbers $11.16 + feature MRC $0.46 + 10DLC $10.00
    // recurring, voice+data $0.82, messaging $30.36. Its tax summary read
    // city $0.17 + state $1.57 + county $0.20 = $1.94 of sales tax, plus
    // $0.11 federal USF and $0.01 cost recovery for a $2.05 total. This
    // models the $1.94; the federal fees are deliberately out of scope.
    expect(
      estimateTelnyxTaxCents({
        recurringCents: 1116 + 46 + 1000,
        voiceUsageCents: 82,
        messagingUsageCents: 3036
      })
    ).toBe(194);
  });

  it("is zero when nothing was spent", () => {
    expect(
      estimateTelnyxTaxCents({ recurringCents: 0, voiceUsageCents: 0, messagingUsageCents: 0 })
    ).toBe(0);
  });
});
