import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import {
  calculateSavingsPercentage,
  getCommitmentMonths,
  getPeriodPricing
} from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { concurrentCallsLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import {
  formatPriceCents,
  formatPricePerMonth,
  getFirstCycleDiscountDisplay,
  hasFirstCycleDiscount
} from "@/lib/pricing";

/**
 * Single source of truth for how the plan tiers are DISPLAYED — feature
 * bullets, price strings, renewal copy — shared by the public /pricing page
 * and the /onboard plan-selection step so the two can never drift apart.
 * All numbers derive from `tier.ts` / `limits.ts`; nothing is hard-coded here.
 */

export const CARRIER_FEE_SETUP_LINE = `One-time ${formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS)} carrier registration · 30-day money-back guarantee`;

export type PeriodOption = {
  id: BillingPeriod;
  label: string;
};

const PERIOD_SHORT_LABEL: Record<BillingPeriod, string> = {
  biennial: "24 months",
  annual: "12 months",
  monthly: "1 month"
};

export const PERIOD_OPTIONS: PeriodOption[] = [
  { id: "biennial", label: PERIOD_SHORT_LABEL.biennial },
  { id: "annual", label: PERIOD_SHORT_LABEL.annual },
  { id: "monthly", label: PERIOD_SHORT_LABEL.monthly }
];

export const PERIOD_LABEL: Record<BillingPeriod, string> = {
  biennial: "24-month plan",
  annual: "12-month plan",
  monthly: "1-month plan"
};

export const PERIOD_SUMMARY: Record<BillingPeriod, { title: string; description: string }> = {
  biennial: {
    title: "Lock in the strongest rate for 24 months",
    description:
      "The full 24-month total is billed today at the lowest effective monthly rate, the highest long-term discount."
  },
  annual: {
    title: "Commit for 12 months and still save materially",
    description:
      "The full 12-month total is billed today. A balanced option if you want real savings without the 24-month commitment."
  },
  monthly: {
    title: "Stay flexible with month-to-month billing",
    description: "No long commitment, with a first-month intro discount before the regular monthly rate renews."
  }
};

export const STARTER_FEATURES: string[] = [
  "AI voice coworker",
  "Phone number and email address dedicated to your coworker",
  "Chat access to your coworker",
  "$5/mo AI budget for agentic tasks",
  "AI image generation (3 per conversation)",
  "Browser can read public web pages",
  "3rd party integrations",
  "Lossless memory and expansive knowledge base",
  "Emails and appointment booking",
  voiceMinutesLine("starter"),
  `${TIER_LIMITS.starter.smsPerMonth} SMS`,
  concurrentCallsLine(TIER_LIMITS.starter.maxConcurrentCalls)
];

export const STANDARD_FEATURES: string[] = [
  "Everything in Starter, plus:",
  voiceMinutesLine("standard"),
  `${TIER_LIMITS.standard.smsPerMonth} SMS`,
  concurrentCallsLine(TIER_LIMITS.standard.maxConcurrentCalls),
  "Bring your own phone number (port-in)",
  "RCS messaging (verified sender)",
  "Zapier: connect 8,000+ apps",
  "Send texts during calls",
  "Auto-text callers when a call can't be answered",
  "Scheduled texts & saved message templates",
  "AI call summaries & caller sentiment on your dashboard",
  "Analytics dashboard: call trends, peak hours & answer rate",
  "Alerts when callers are turned away (missed-call spikes)",
  "Warm handoff call transfers",
  "$10/mo AI budget for agentic tasks, before free model fallback",
  "Configuration and training updates",
  "Priority email support & maintenance",
  "Full browser skills: operates websites like a person (logins, forms, portals)"
];

/**
 * Every bullet here is SHIPPED product (enterprise feature buildout,
 * Phases 1–6) or an explicit operational commitment — this list is what
 * sales quotes, so keep it honest:
 *  - team roles + access control: business_members + authz matrix (Phase 1)
 *  - multi-business agency dashboard: active-business switcher (Phase 2)
 *  - white-label dashboard: businesses.branding (Phase 3)
 *  - designated models + voice picker: enterprise_models (Phase 4;
 *    prebuilt professional voices, not cloning)
 *  - custom compliance modules: compliance_module (Phase 5)
 *  - SLA + dedicated support: permanent priority window + support card
 *    (Phase 6)
 */
export const ENTERPRISE_FEATURES: string[] = [
  "Everything in Starter and Standard, plus:",
  "Multi-business agency dashboard with one login",
  "Team access with roles (managers & staff)",
  "White-label dashboard (your name, logo, colors)",
  "SLA + dedicated support, priority always on",
  "Custom compliance modules",
  "Designated reasoning models",
  "Choice of professional voices",
  "Custom usage limits and call customization",
  "Independent hardware deployment & data residency",
  "Quarterly strategy reviews",
  "Priority access to new features"
];

export type TierCard = {
  id: PlanTier;
  name: string;
  price: string;
  originalPrice?: string;
  renewal?: string;
  total?: string;
  introOffer?: string;
  setup: string;
  features: string[];
  cta: string;
  highlight: boolean;
  badge?: string;
};

function getTierPricingDisplay(tier: Exclude<PlanTier, "enterprise">, period: BillingPeriod) {
  const pricing = getPeriodPricing(tier, period);
  const months = getCommitmentMonths(period);
  return {
    monthly: formatPricePerMonth(pricing.monthlyCents),
    renewalRate: formatPricePerMonth(pricing.renewalMonthlyCents),
    total: formatPriceCents(pricing.monthlyCents * months),
    hasIntroDiscount: hasFirstCycleDiscount(tier, period),
    firstCycleDiscount: getFirstCycleDiscountDisplay(tier, period)
  };
}

function buildPaidTierCard(
  tier: Exclude<PlanTier, "enterprise">,
  period: BillingPeriod
): Omit<TierCard, "name" | "features" | "cta" | "highlight" | "badge"> {
  const price = getTierPricingDisplay(tier, period);
  return {
    id: tier,
    price: price.monthly,
    originalPrice: price.hasIntroDiscount ? price.renewalRate : undefined,
    renewal:
      period !== "monthly"
        ? `Renews at ${price.renewalRate} after ${PERIOD_SHORT_LABEL[period]}`
        : `Renews at ${price.renewalRate}`,
    total:
      period !== "monthly"
        ? `${price.total} billed today for the ${PERIOD_LABEL[period]}`
        : undefined,
    // Only the monthly plan carries a first-cycle intro discount today, so
    // `hasIntroDiscount` alone decides — no separate period check needed.
    introOffer: price.hasIntroDiscount
      ? `First month discount saves ${price.firstCycleDiscount}`
      : undefined,
    setup: CARRIER_FEE_SETUP_LINE
  };
}

export function getTierCards(period: BillingPeriod): TierCard[] {
  return [
    {
      ...buildPaidTierCard("starter", period),
      name: "Starter",
      features: STARTER_FEATURES,
      cta: "Choose Starter",
      highlight: false,
      badge: period === "biennial" ? "Best Value" : undefined
    },
    {
      ...buildPaidTierCard("standard", period),
      name: "Standard",
      features: STANDARD_FEATURES,
      cta: "Choose Standard",
      highlight: true,
      badge: "Most Popular"
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: "Custom",
      renewal: undefined,
      total: undefined,
      setup: "Contact us for pricing",
      features: ENTERPRISE_FEATURES,
      cta: "Contact Sales",
      highlight: false,
      badge: undefined
    }
  ];
}

export type TierSavings = Record<"biennial" | "annual", number>;

export function getTierSavings(tier: Exclude<PlanTier, "enterprise">): TierSavings {
  return {
    biennial: calculateSavingsPercentage(tier, "biennial"),
    annual: calculateSavingsPercentage(tier, "annual")
  };
}
