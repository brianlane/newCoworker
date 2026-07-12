import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_MARGIN_ALERT_THRESHOLD_CENTS,
  MARGIN_ALERT_SETTINGS_KEY,
  MAX_THRESHOLD_CENTS,
  MIN_THRESHOLD_CENTS,
  findMarginBreaches,
  parseMarginAlertConfig,
  runMarginAlert,
  serializeMarginAlertConfig,
  type MarginAlertDeps
} from "@/lib/admin/margin-alert";
import { buildOpsMarginAlertEmail } from "@/lib/email/templates/ops-margin-alert";
import type { BusinessMarginEconomics } from "@/lib/admin/margin";

function economics(overrides: Partial<BusinessMarginEconomics> = {}): BusinessMarginEconomics {
  return {
    businessId: "biz-1",
    revenueCents: 18_900,
    revenueSource: "subscription",
    lines: [],
    costCents: 4_000,
    marginCents: 14_900,
    ...overrides
  };
}

describe("parseMarginAlertConfig", () => {
  it("defaults for null / non-objects / missing fields", () => {
    const defaults = {
      enabled: false,
      thresholdCents: DEFAULT_MARGIN_ALERT_THRESHOLD_CENTS
    };
    expect(parseMarginAlertConfig(null)).toEqual(defaults);
    expect(parseMarginAlertConfig("x")).toEqual(defaults);
    expect(parseMarginAlertConfig({})).toEqual(defaults);
    expect(parseMarginAlertConfig({ thresholdCents: "50" })).toEqual(defaults);
    expect(parseMarginAlertConfig({ thresholdCents: Number.NaN })).toEqual(defaults);
    expect(parseMarginAlertConfig({ enabled: "yes" })).toEqual(defaults);
  });

  it("round-trips through serialize and clamps + rounds the threshold", () => {
    const config = { enabled: true, thresholdCents: 2_500 };
    expect(parseMarginAlertConfig(serializeMarginAlertConfig(config))).toEqual(config);
    expect(parseMarginAlertConfig({ thresholdCents: 10.6 }).thresholdCents).toBe(11);
    expect(parseMarginAlertConfig({ thresholdCents: 99_999_999 }).thresholdCents).toBe(
      MAX_THRESHOLD_CENTS
    );
    expect(parseMarginAlertConfig({ thresholdCents: -99_999_999 }).thresholdCents).toBe(
      MIN_THRESHOLD_CENTS
    );
  });
});

describe("findMarginBreaches", () => {
  const names = new Map([["biz-loss", "Loss Leader LLC"]]);
  const config = { enabled: true, thresholdCents: 0 };

  it("returns paying tenants below the floor, worst first, with name fallbacks", () => {
    const breaches = findMarginBreaches({
      economics: [
        economics(), // healthy — excluded
        economics({ businessId: "biz-loss", marginCents: -500, costCents: 19_400 }),
        economics({
          businessId: "00000000-dead-beef-0000-000000000000",
          revenueSource: "enterprise_deal",
          marginCents: -2_000
        }),
        // Non-paying at a loss — excluded by design (pool/pilot burn).
        economics({ businessId: "biz-pilot", revenueSource: "none", marginCents: -9_999 })
      ],
      businessNames: names,
      config
    });
    expect(breaches.map((b) => b.businessId)).toEqual([
      "00000000-dead-beef-0000-000000000000",
      "biz-loss"
    ]);
    expect(breaches[0].businessName).toBe("00000000…");
    expect(breaches[1]).toMatchObject({
      businessName: "Loss Leader LLC",
      revenueCents: 18_900,
      costCents: 19_400,
      marginCents: -500
    });
  });

  it("respects a positive floor", () => {
    const breaches = findMarginBreaches({
      economics: [economics({ marginCents: 2_000 })],
      businessNames: names,
      config: { enabled: true, thresholdCents: 2_500 }
    });
    expect(breaches).toHaveLength(1);
  });
});

describe("runMarginAlert", () => {
  function deps(overrides: Partial<MarginAlertDeps> = {}): MarginAlertDeps {
    return {
      getConfigRaw: vi.fn(async () => ({ enabled: true, thresholdCents: 0 })),
      loadEconomics: vi.fn(async () => ({
        economics: [economics({ businessId: "biz-loss", marginCents: -500 })],
        businessNames: new Map([["biz-loss", "Loss Leader LLC"]])
      })),
      sendAlertEmail: vi.fn(async () => {}),
      ...overrides
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("short-circuits without loading economics when disabled", async () => {
    const d = deps({ getConfigRaw: vi.fn(async () => ({ enabled: false })) });
    const result = await runMarginAlert(d);
    expect(result).toEqual({
      enabled: false,
      thresholdCents: 0,
      breaches: [],
      emailed: false
    });
    expect(d.loadEconomics).not.toHaveBeenCalled();
    expect(d.sendAlertEmail).not.toHaveBeenCalled();
  });

  it("emails the digest when breaches exist", async () => {
    const d = deps();
    const result = await runMarginAlert(d);
    expect(result.emailed).toBe(true);
    expect(result.breaches).toHaveLength(1);
    expect(d.sendAlertEmail).toHaveBeenCalledWith({
      breaches: result.breaches,
      thresholdCents: 0
    });
    expect(MARGIN_ALERT_SETTINGS_KEY).toBe("margin_alert_config");
  });

  it("stays silent on a clean fleet", async () => {
    const d = deps({
      loadEconomics: vi.fn(async () => ({
        economics: [economics()],
        businessNames: new Map<string, string>()
      }))
    });
    const result = await runMarginAlert(d);
    expect(result.emailed).toBe(false);
    expect(d.sendAlertEmail).not.toHaveBeenCalled();
  });
});

describe("buildOpsMarginAlertEmail", () => {
  it("formats the digest with signed money and the costs-page CTA", () => {
    const { subject, text, html } = buildOpsMarginAlertEmail({
      breaches: [
        {
          businessId: "biz-loss",
          businessName: "Loss Leader LLC",
          revenueCents: 18_900,
          costCents: 19_400,
          marginCents: -500
        }
      ],
      thresholdCents: 0,
      siteUrl: "https://www.example.com"
    });
    expect(subject).toBe("[ops] Margin alert: 1 paying tenant(s) below $0.00/mo");
    expect(text).toContain(
      "Loss Leader LLC (biz-loss): margin -$5.00/mo — revenue $189.00, cost $194.00"
    );
    expect(html).toContain("https://www.example.com/admin/costs");
  });
});
