/**
 * Enterprise deal pricing — cost model + suggested setup/monthly prices.
 *
 * Enterprise is custom-priced ($0 in tier.ts; "Contact Sales" on /pricing),
 * so the operator needs to know what a given deal COSTS us before quoting.
 * The per-unit constants here are a code snapshot of the tier-economics
 * canvas (PRDs/tier-economics-jul-2026.md): live Hostinger catalog (Jul 2
 * 2026), Amy's 90-day Telnyx invoice records, the vps/voice-bridge Gemini
 * Live rate, and standard Stripe pricing. They are estimation inputs for the
 * admin panel calculator — nothing bills from them — so drift against the
 * live vendor catalogs degrades a SUGGESTION, never an invoice.
 */

import type { VpsSize } from "@/lib/vps/size";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";

/** Hostinger monthly-SKU price per box size (we buy monthly regardless of the customer's term). */
export const HOSTING_MONTHLY_CENTS_BY_SIZE: Record<VpsSize, number> = {
  kvm1: 1199,
  kvm2: 2449,
  kvm4: 4299,
  kvm8: 7399
};

/**
 * Per-unit marginal costs, in cents (fractional cents kept — totals are
 * rounded once at the end).
 */
export const ENTERPRISE_UNIT_COSTS = {
  /**
   * Blended outbound SMS incl. 10DLC carrier fees (pessimistic bound).
   * US-destination blend: +52 traffic costs smsOutboundCentsPerMessageMx
   * per PART instead. The fleet aggregates (MRR, margin, usage-charges)
   * deliberately keep this blend because usage snapshots carry no
   * per-message destination country; Mexican tenants' delta is offset by
   * the flat Mexican messaging surcharge plus the 100/month MX cap.
   * Re-rate per destination when message logs carry the country.
   */
  smsOutboundCentsPerMessage: 1.59,
  /**
   * Telnyx list price per message PART to Mexico (pay-as-you-go, read off
   * the pricing page country selector Aug 2026; confirm against the
   * account rate deck in Mission Control). Accented Spanish is UCS-2 at 70
   * chars/part, so a typical Spanish message is 2+ parts. Consumed by the
   * Mexican surcharge sizing math (see mexican-messaging.ts), not by the
   * fleet aggregates.
   */
  smsOutboundCentsPerMessageMx: 9.1,
  smsInboundCentsPerMessage: 0.63,
  /**
   * Telnyx voice all-in per minute. The June 2026 invoice prices a bridged
   * AI call minute at ~0.89 cents: origination 0.35 + call control 0.2 per
   * leg + media streaming 0.35 + call recording 0.2 ($0.32 over 36 min).
   * The pre-Aug-2026 figure of 0.55 missed the invoice-only adjunct lines
   * (call control, media streaming, recording never appear in
   * /v2/detail_records; see TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE).
   */
  voiceTelnyxCentsPerMinute: 0.9,
  /** Gemini Live realtime audio. */
  voiceGeminiCentsPerMinute: 2.25,
  /** Telnyx DID rental per number per month ($1.00 DID + $0.10 SMS MRC). */
  didMonthlyCents: 110,
  /** Stripe card fee on every charge (US card, US account). */
  stripePercent: 0.029,
  stripeFixedCentsPerCharge: 30,
  /**
   * Stripe's surcharge when the CARD was issued outside the US, on top of
   * `stripePercent`. Standard published pricing; it is a per-charge fact
   * about the customer's card, not about our account, so the margin engine
   * can only estimate it from the tenant's resolved country until the
   * Stripe fee sync has observed real charges (see
   * src/lib/plans/stripe-fees.ts).
   */
  stripeInternationalPercent: 0.015
} as const;

/**
 * The shared 10DLC campaign's monthly registration fee: one CUSTOMER_CARE
 * campaign covers the whole fleet today, billed on the 6th (invoice code
 * 10DLC-CAMPAIGN-FEE-REGULAR-MRC, auto-renewing). Scale this only if more
 * campaigns are ever registered; it is a platform fixed cost, never
 * per-tenant.
 */
export const TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS = 1000;

/**
 * Voice line items that exist ONLY on the Telnyx invoice, never in
 * /v2/detail_records (call control, media streaming, call recording).
 * Synced `telnyx_cost_daily` actuals therefore understate voice by about
 * this much per metered minute; views built on actuals add this top-up so
 * they mirror the invoice. The rate-estimate paths must NOT add it: the
 * 0.9 cents/min voiceTelnyxCentsPerMinute above already includes it.
 *
 * Two invoices, denominator = synced billed minutes (both call legs, which
 * is what the adjuncts also meter):
 *   Jun 2026  $0.18 over  36.5 min = 0.49 c/min  (the original calibration)
 *   Jul 2026  $0.39 over 102.2 min = 0.38 c/min
 * Blended across both, 0.41. Rounded to 0.4: July is the 2.8x larger sample,
 * and June's single-tenant mix over half an hour of calls was thin.
 */
export const TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE = 0.4;

/**
 * Effective Telnyx tax rates, calibrated from the June 2026 invoice
 * (Arizona account address). Telnyx taxes usage and recurring fees very
 * differently: $0.389 of tax landed on $7.16 of usage (5.4%: state,
 * county, city sales tax + federal USF on voice) while $0.071 landed on
 * $11.10 of MRCs (0.64%). Jurisdiction and product-mix dependent, so
 * recalibrate against a newer invoice if the account address or the
 * usage mix shifts materially.
 */
export const TELNYX_USAGE_TAX_RATE = 0.054;
export const TELNYX_MRC_TAX_RATE = 0.0064;

/** All-in voice cost per minute (Telnyx + Gemini Live). */
export const VOICE_ALL_IN_CENTS_PER_MINUTE =
  ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute +
  ENTERPRISE_UNIT_COSTS.voiceGeminiCentsPerMinute;

/**
 * Default onboarding-labor component of the suggested setup fee: white-glove
 * provisioning, training, and deal-specific configuration by the founder.
 * The admin can override it in the calculator.
 */
export const DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS = 75_000;

export type EnterpriseUsageAssumptions = {
  vpsSize: VpsSize;
  /** Expected outbound SMS per month. */
  smsPerMonth: number;
  /** Expected voice minutes per month (Telnyx + Gemini path). */
  voiceMinutesPerMonth: number;
  /** Phone numbers beyond the included one. */
  extraDids?: number;
};

export type EnterpriseCostLineItem = {
  label: string;
  cents: number;
};

export type EnterpriseMonthlyCostEstimate = {
  items: EnterpriseCostLineItem[];
  /** Sum of items, rounded to whole cents. */
  totalCents: number;
};

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

/**
 * Estimated monthly marginal cost of hosting one enterprise tenant at the
 * given usage. Excludes Stripe fees — those depend on the PRICE, not the
 * cost, and are solved for in {@link suggestEnterprisePrice}.
 */
export function estimateEnterpriseMonthlyCost(
  usage: EnterpriseUsageAssumptions
): EnterpriseMonthlyCostEstimate {
  assertFiniteNonNegative(usage.smsPerMonth, "smsPerMonth");
  assertFiniteNonNegative(usage.voiceMinutesPerMonth, "voiceMinutesPerMonth");
  const extraDids = usage.extraDids ?? 0;
  assertFiniteNonNegative(extraDids, "extraDids");

  const hosting = HOSTING_MONTHLY_CENTS_BY_SIZE[usage.vpsSize];
  const sms = usage.smsPerMonth * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage;
  const voice = usage.voiceMinutesPerMonth * VOICE_ALL_IN_CENTS_PER_MINUTE;
  const dids = (1 + extraDids) * ENTERPRISE_UNIT_COSTS.didMonthlyCents;
  // Tax applies to the Telnyx components only: SMS, the Telnyx share of the
  // voice minute (Gemini bills through Google untaxed here), and DID MRCs.
  const telnyxUsageTaxable =
    sms + usage.voiceMinutesPerMonth * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute;
  const taxes =
    telnyxUsageTaxable * TELNYX_USAGE_TAX_RATE + dids * TELNYX_MRC_TAX_RATE;

  const items: EnterpriseCostLineItem[] = [
    { label: `Hosting (${usage.vpsSize.toUpperCase()} monthly SKU)`, cents: hosting },
    { label: `SMS (${usage.smsPerMonth.toLocaleString("en-US")} outbound/mo)`, cents: sms },
    {
      label: `Voice (${usage.voiceMinutesPerMonth.toLocaleString("en-US")} min/mo, Telnyx + Gemini)`,
      cents: voice
    },
    { label: `Phone numbers (${1 + extraDids} DID${extraDids > 0 ? "s" : ""})`, cents: dids },
    { label: "Telnyx taxes (est.)", cents: taxes }
  ];

  return {
    items,
    totalCents: Math.round(items.reduce((sum, item) => sum + item.cents, 0))
  };
}

export type EnterprisePriceSuggestion = {
  /** Suggested recurring monthly price. */
  monthlyCents: number;
  /** Suggested one-time setup fee. */
  setupCents: number;
  /** Expected monthly net margin at the suggested monthly price (after Stripe fees + cost). */
  monthlyNetMarginCents: number;
};

/** Round a price UP to the next multiple of $5 so suggestions look intentional. */
function roundUpToFiveDollars(cents: number): number {
  return Math.ceil(cents / 500) * 500;
}

/**
 * Suggests a monthly price that yields `targetMarginPct` of REVENUE as net
 * margin after Stripe fees and the estimated cost, plus a setup fee that
 * covers onboarding labor and the one-time 10DLC carrier registration,
 * grossed up so Stripe's cut doesn't eat into either.
 *
 * Monthly: solve P from  P·(1 − stripe% − margin%) − stripeFixed = cost.
 * Setup:   solve S from  S·(1 − stripe%) − stripeFixed = labor + carrierFee.
 */
export function suggestEnterprisePrice(
  monthlyCostCents: number,
  targetMarginPct: number,
  setupLaborCents: number = DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS
): EnterprisePriceSuggestion {
  assertFiniteNonNegative(monthlyCostCents, "monthlyCostCents");
  assertFiniteNonNegative(setupLaborCents, "setupLaborCents");
  if (!Number.isFinite(targetMarginPct) || targetMarginPct < 0 || targetMarginPct > 90) {
    throw new Error("targetMarginPct must be between 0 and 90");
  }

  const { stripePercent, stripeFixedCentsPerCharge } = ENTERPRISE_UNIT_COSTS;
  const marginFraction = targetMarginPct / 100;

  const rawMonthly =
    (monthlyCostCents + stripeFixedCentsPerCharge) / (1 - stripePercent - marginFraction);
  const monthlyCents = roundUpToFiveDollars(rawMonthly);

  const rawSetup =
    (setupLaborCents + CARRIER_REGISTRATION_FEE_CENTS + stripeFixedCentsPerCharge) /
    (1 - stripePercent);
  const setupCents = roundUpToFiveDollars(rawSetup);

  const monthlyNetMarginCents = Math.round(
    monthlyCents * (1 - stripePercent) - stripeFixedCentsPerCharge - monthlyCostCents
  );

  return { monthlyCents, setupCents, monthlyNetMarginCents };
}
