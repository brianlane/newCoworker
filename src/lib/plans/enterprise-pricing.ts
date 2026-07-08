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
  /** Blended outbound SMS incl. 10DLC carrier fees (pessimistic bound). */
  smsOutboundCentsPerMessage: 1.59,
  smsInboundCentsPerMessage: 0.63,
  /** Telnyx inbound + Voice API. */
  voiceTelnyxCentsPerMinute: 0.55,
  /** Gemini Live realtime audio. */
  voiceGeminiCentsPerMinute: 2.25,
  /** Telnyx DID rental per number per month. */
  didMonthlyCents: 110,
  /** Stripe card fee on every charge. */
  stripePercent: 0.029,
  stripeFixedCentsPerCharge: 30
} as const;

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

  const items: EnterpriseCostLineItem[] = [
    { label: `Hosting (${usage.vpsSize.toUpperCase()} monthly SKU)`, cents: hosting },
    { label: `SMS (${usage.smsPerMonth.toLocaleString("en-US")} outbound/mo)`, cents: sms },
    {
      label: `Voice (${usage.voiceMinutesPerMonth.toLocaleString("en-US")} min/mo, Telnyx + Gemini)`,
      cents: voice
    },
    { label: `Phone numbers (${1 + extraDids} DID${extraDids > 0 ? "s" : ""})`, cents: dids }
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
