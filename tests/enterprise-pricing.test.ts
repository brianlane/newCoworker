import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE,
  VOICE_ALL_IN_CENTS_PER_MINUTE,
  DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS,
  estimateEnterpriseMonthlyCost,
  suggestEnterprisePrice
} from "@/lib/plans/enterprise-pricing";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";

describe("estimateEnterpriseMonthlyCost", () => {
  it("itemizes hosting + SMS + voice + DID and totals them", () => {
    const est = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm8",
      smsPerMonth: 1000,
      voiceMinutesPerMonth: 500,
      extraDids: 2
    });

    const expected =
      HOSTING_MONTHLY_CENTS_BY_SIZE.kvm8 + // 7399
      1000 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage + // 1590
      500 * VOICE_ALL_IN_CENTS_PER_MINUTE + // 1400
      3 * ENTERPRISE_UNIT_COSTS.didMonthlyCents; // 330

    expect(est.items).toHaveLength(4);
    expect(est.totalCents).toBe(Math.round(expected));
    expect(est.totalCents).toBe(10_719);
  });

  it("defaults extraDids to 0 (one included DID)", () => {
    const est = estimateEnterpriseMonthlyCost({
      vpsSize: "kvm2",
      smsPerMonth: 0,
      voiceMinutesPerMonth: 0
    });
    expect(est.totalCents).toBe(
      HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2 + ENTERPRISE_UNIT_COSTS.didMonthlyCents
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
