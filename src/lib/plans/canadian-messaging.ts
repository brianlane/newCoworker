/**
 * Canadian messaging surcharge, detection + fee constants.
 *
 * Canadian carriers charge per-message pass-through surcharges (~$0.004–0.010
 * USD/part) that US traffic doesn't, and Canadian tenants' numbers must ride
 * a messaging profile whose whitelisted destinations include CA. New signups
 * detected as Canadian pay a flat, clearly-labeled monthly surcharge that
 * offsets those carrier costs; it rides the Stripe subscription as its own
 * recurring line item (billed at the plan's cadence, upfront × months on
 * term plans, like the plan itself).
 *
 * Detection is deterministic from data we already collect at signup: the
 * owner's phone area code (the same signal that biases their coworker number
 * search local to them) against the Canadian NANP set, with the browser
 * timezone as the fallback when the phone isn't a NANP number. Since the
 * Mexico rollout the actual resolution lives in business-country.ts
 * (resolveBusinessCountry, a three-way US/CA/MX rule); this module keeps the
 * Canada-specific fee constants and the isCanadianBusiness entry point, and
 * re-exports the moved data sets so existing import sites stay byte-stable.
 *
 * One deliberate delta from the pre-Mexico behavior, pinned by tests: a +52
 * phone with a Canadian browser timezone used to classify Canadian (the
 * phone fell through as non-NANP); it now classifies Mexican, phone
 * authoritative. Fees only attach at new-signup checkout, so no existing
 * tenant's billing can change.
 *
 * Existing tenants are grandfathered by construction: the fee is only added
 * by the NEW-SIGNUP checkout, never retrofitted onto live subscriptions.
 *
 * Pure module (no server imports) so the onboarding order summary, a client
 * component, can run the same detection the checkout route bills from.
 */

import { nanpNpaFromPhone, resolveBusinessCountry } from "./business-country";

export { CANADIAN_AREA_CODES, CANADIAN_TIMEZONES } from "./business-country";

/** Flat monthly surcharge, all tiers ($4.99/mo). */
export const CANADA_MESSAGING_FEE_MONTHLY_CENTS = 499;

/**
 * Product name on the Stripe line item, the customer-visible label on
 * checkout, invoices, and the billing portal. Also the sentinel other code
 * can use to find the fee line on an invoice (same pattern as
 * CARRIER_REGISTRATION_FEE_NAME).
 */
export const CANADA_MESSAGING_FEE_NAME = "Canadian messaging surcharge";

/**
 * NANP area code (NPA) from a free-form onboarding phone string, or null.
 * Moved to business-country.ts; kept exported here under its historical
 * name for existing import sites.
 */
export function canadianNpaFromPhone(raw: string | null | undefined): string | null {
  return nanpNpaFromPhone(raw);
}

/**
 * True when the signup resolves to Canada: the owner phone's NANP area code
 * is a Canadian NPA (authoritative, it also drives which country their
 * coworker number is purchased in), else the browser timezone. Both signals
 * absent/inconclusive ⇒ not Canadian (fee skipped, US profile). See
 * resolveBusinessCountry for the full three-way rule.
 */
export function isCanadianBusiness(input: {
  phone?: string | null;
  timezone?: string | null;
}): boolean {
  return resolveBusinessCountry(input) === "CA";
}
