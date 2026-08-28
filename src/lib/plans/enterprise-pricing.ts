/**
 * Enterprise deal pricing: cost model + suggested setup/monthly prices.
 *
 * Enterprise is custom-priced ($0 in tier.ts; "Contact Sales" on /pricing),
 * so the operator needs to know what a given deal COSTS us before quoting.
 * The per-unit constants here are a code snapshot of the tier-economics
 * canvas (PRDs/tier-economics-jul-2026.md): live Hostinger catalog (Jul 2
 * 2026), Amy's 90-day Telnyx invoice records, the vps/voice-bridge Gemini
 * Live rate, and standard Stripe pricing. They are estimation inputs for the
 * admin panel calculator (nothing bills from them), so drift against the
 * live vendor catalogs degrades a SUGGESTION, never an invoice.
 */

import type { VpsSize } from "@/lib/vps/size";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import {
  NANP_BASELINE_CENTS_PER_MINUTE,
  blendedVoiceTerminationRate
} from "@/lib/plans/voice-zone-rates";

/** Hostinger monthly-SKU price per box size (we buy monthly regardless of the customer's term). */
export const HOSTING_MONTHLY_CENTS_BY_SIZE: Record<VpsSize, number> = {
  kvm1: 1199,
  kvm2: 2449,
  kvm4: 4299,
  kvm8: 7399
};

/**
 * Per-unit marginal costs, in cents (fractional cents kept, totals are
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
   *
   * THIS IS A ZONE 1 MINUTE. Telnyx prices termination per NPA-NXX, and
   * both calibration months were traffic that never left the lower-48
   * baseline: zone-matching all 104 outbound legs we had ever placed on
   * 2026-08-28 put 100% of them in US Zone 1, at an effective 0.5333c/min
   * of termination against the deck's 0.5c. So this figure is sound for
   * lower-48 traffic and understates a rural list, where a "High Cost
   * (Zone 5)" minute terminates at 7c. The gap is priced separately as a
   * surcharge over baseline in estimateEnterpriseMonthlyCost, never folded
   * in here, because folding it in would silently bill Zone 1 termination
   * twice. See src/lib/plans/voice-zone-rates.ts.
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
 * Combined Arizona transaction privilege tax on telecommunications at the
 * account's Mesa billing address, verified against primary sources on
 * 2026-08-17 (ADOR TPT rate table effective 2026-07-01, business code 005
 * Communications):
 *
 *   state    5.6%  (5% telecom classification, A.R.S. 42-5010(A)(1)(c),
 *                   plus the 0.6% education increment, 42-5010.01,
 *                   in force through 2041)
 *   Maricopa 0.7%
 *   Mesa     2.0%
 *
 * Mesa happens to tax telecom at its retail rate; other Arizona cities do
 * not (Marana charges 4% on communications vs 2.5% retail), so this must be
 * re-derived if the billing address ever moves.
 */
export const TELNYX_TPT_COMBINED_RATE = 0.083;

/**
 * Share of messaging spend that Arizona can actually tax.
 *
 * The tax turns on GEOGRAPHY, not product type. A.R.S. 42-5064(A) limits
 * the telecommunications classification to "the business of providing
 * intrastate telecommunications services", and (E)(5) requires the traffic
 * to "originate and terminate in this state". Cities are barred from
 * reaching interstate telecom outright by 42-6004(A)(2). Messaging is NOT
 * exempt (ADOR ruling TPR 04-1 Example 7: "Charges for text messaging are
 * taxable"), it is simply mostly out of state: A2P traffic from our tenant
 * DIDs lands nationwide, so only the Arizona-to-Arizona sliver is in scope.
 * 42-5064(D)(1) expressly lets the carrier apply such an allocation.
 *
 * 3% is INFERRED from the July 2026 invoice, not confirmed by Telnyx: the
 * $1.94 of sales tax implies a taxable base near $23.37, and everything
 * except messaging totals $22.44, leaving roughly 3% of the $30.36
 * messaging line. That the remainder is nonzero is itself the evidence for
 * an intrastate allocation rather than a blanket exclusion (a blanket one
 * would have yielded $1.86).
 *
 * Expect this to DRIFT DOWNWARD: it is the Arizona-to-Arizona fraction of
 * fleet traffic, and most tenants are not in Arizona (Montreal, Ontario,
 * Miami). To replace it with a real number, ask Telnyx for the per-line
 * taxable base on a recent invoice and the intrastate allocation percentage
 * they apply to Arizona messaging. That second answer also says whether
 * their basis is interstate sourcing (stable, and what this models) or an
 * FCC information-service classification, which Arizona's statute does not
 * support and which would mean back-tax exposure on the untaxed remainder.
 *
 * To re-derive it from an invoice unaided: sum the city, state and county
 * tax lines, divide by TELNYX_TPT_COMBINED_RATE for the taxable base,
 * subtract every non-messaging charge, then divide by the messaging line.
 */
export const TELNYX_MESSAGING_INTRASTATE_SHARE = 0.03;

/**
 * Estimated Telnyx tax on one month of spend, in cents.
 *
 * The single implementation behind every view that reports Telnyx tax (the
 * fleet cost model in src/lib/admin/fleet-cost.ts, which the Dashboard,
 * Revenue and Costs pages all render, plus the enterprise deal calculator
 * below) so they cannot drift apart.
 *
 * Recurring charges (DID rentals, the 10DLC campaign fee) are sourced to
 * the Mesa service address with no origination/termination split to make,
 * so they are taxed in full. Voice is likewise treated as fully taxable:
 * the July 2026 invoice reconciles that way, and our bridged AI calls are
 * predominantly Arizona-to-Arizona. Messaging carries only its intrastate
 * share.
 *
 * This returns SALES tax only, and reproduces the July 2026 invoice's
 * city + state + county lines exactly ($1.94; see the test). The invoice's
 * $2.05 total also carried $0.11 federal USF and $0.01 cost recovery,
 * deliberately excluded here: USF applies to interstate and international
 * TELECOM revenue, and messaging is excluded federally as a Title I
 * information service (FCC 18-178), so it assessed just $0.28 of revenue.
 * The model therefore runs about $0.12/month light. Add a USF line only if
 * the fleet ever carries material interstate voice; the Q3 2026
 * contribution factor is 38.8%, an all-time high, so it would not stay
 * negligible.
 */
export function estimateTelnyxTaxCents(params: {
  /** DID rentals + the 10DLC campaign fee. */
  recurringCents: number;
  /** Voice legs plus the invoice-only adjuncts. */
  voiceUsageCents: number;
  /** SMS/MMS/RCS spend, taxed only on its intrastate share. */
  messagingUsageCents: number;
}): number {
  const taxable =
    params.recurringCents +
    params.voiceUsageCents +
    params.messagingUsageCents * TELNYX_MESSAGING_INTRASTATE_SHARE;
  return Math.round(taxable * TELNYX_TPT_COMBINED_RATE);
}

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
  /**
   * The numbers this tenant will actually dial, when they are known (a
   * prospect's imported contact list, say). Supplying them prices the
   * high-cost-zone surcharge from the real destination mix instead of
   * assuming every minute is a lower-48 Zone 1 minute.
   *
   * Optional on purpose: with no list the estimate is byte-for-byte what it
   * was before the zone table existed, so no existing surface moves.
   */
  voiceDestinations?: readonly (string | null | undefined)[];
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
 * given usage. Excludes Stripe fees: those depend on the PRICE, not the
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

  // HIGH-COST ZONE SURCHARGE, and why it is a surcharge rather than a
  // replacement for the termination component of `voice` above.
  //
  // Telnyx prices termination per NPA-NXX, not per country: the US spread
  // runs from 0.5c/min in the lower 48 to 7c in "High Cost (Zone 5)" and
  // 18.1c in Zone 6, and those prefixes are overwhelmingly rural.
  // `voiceTelnyxCentsPerMinute` (0.9) is a single blended figure
  // back-calibrated from the June and July 2026 invoices. Measuring every
  // outbound leg we had ever placed on 2026-08-28 showed all 104 of them
  // landed in Zone 1, so that 0.9 already contains a Zone 1 termination
  // rate. Adding a full zone rate on top would bill termination twice.
  //
  // The INCREMENT above baseline is the part 0.9 cannot contain, and it is
  // additive with no double count. A tenant dialing only the lower 48 gets
  // exactly 0 here, which is why the line disappears rather than showing a
  // rounded-to-zero surcharge.
  const zoneBlend = usage.voiceDestinations
    ? blendedVoiceTerminationRate(usage.voiceDestinations)
    : null;
  const zoneSurchargeCentsPerMinute = zoneBlend
    ? Math.max(0, zoneBlend.centsPerMinute - NANP_BASELINE_CENTS_PER_MINUTE)
    : 0;
  const zoneSurcharge = usage.voiceMinutesPerMonth * zoneSurchargeCentsPerMinute;
  // Tax applies to the Telnyx components only (Gemini bills through Google
  // untaxed here). DID MRCs are sourced to the billing address and taxed in
  // full; messaging only on its intrastate share. The 10DLC campaign fee is
  // NOT included: it is a flat platform-wide cost, never per-tenant.
  const taxes = estimateTelnyxTaxCents({
    recurringCents: dids,
    voiceUsageCents:
      usage.voiceMinutesPerMonth * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute +
      zoneSurcharge,
    messagingUsageCents: sms
  });

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

  // Insert ahead of the tax line so the itemization reads cost-then-tax.
  if (zoneSurcharge > 0 && zoneBlend) {
    items.splice(items.length - 1, 0, {
      label: `Voice high-cost zones (${zoneBlend.centsPerMinute}c/min blended over the ${NANP_BASELINE_CENTS_PER_MINUTE}c baseline, ${zoneBlend.priced} destination${zoneBlend.priced === 1 ? "" : "s"})`,
      cents: zoneSurcharge
    });
  }

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
