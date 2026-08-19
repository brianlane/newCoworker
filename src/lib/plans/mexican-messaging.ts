/**
 * Mexican messaging surcharge, detection + fee constants.
 *
 * Mexican tenants keep a US +1 coworker number in v1, so their SMS
 * terminates at +52 as international A2P: Telnyx list price $0.091/part
 * against the ~$0.0159 blended US rate the tiers were priced on (and
 * accented Spanish is UCS-2 at 70 chars/part, so a typical message is 2+
 * parts). Calls to the owner's +52 cell run ~2.5c/min all-in against the
 * 0.9c US model. New signups detected as Mexican pay a flat, clearly
 * labeled monthly surcharge that offsets those deltas; it rides the Stripe
 * subscription as its own recurring line item (billed at the plan's
 * cadence, upfront x months on term plans, like the plan itself), exactly
 * mirroring the Canadian surcharge in canadian-messaging.ts.
 *
 * The fee is deliberately NOT the whole exposure control: customer-facing
 * SMS for Mexican non-enterprise tenants is capped at 100/month
 * (SMS_MONTHLY_CAP_MX; enforced in Postgres by
 * try_reserve_sms_outbound_slot, see the mx_sms_cap migration), because no
 * flat fee covers the standard tier's 3,000-message cap at MX rates.
 * WhatsApp, billed by Meta to the tenant's own WABA, is the intended
 * volume channel for Mexican customer traffic.
 *
 * Amount math at the $9.99 default: worst cases are ~$7.51 of capped
 * customer SMS delta (100 single-part messages) plus ~$4 of voice delta at
 * the standard tier's included minutes; typical usage sits well under the
 * fee. Operational owner texts never hard-stop (meter_operational_sms) and
 * ride the same $0.091 rate, so a notification-heavy month can exceed the
 * fee; revisit with real usage data.
 *
 * Detection is resolveBusinessCountry (business-country.ts): the same
 * values the messaging-profile pick and DID search classify from, so
 * capability and fee travel together. Existing tenants are grandfathered
 * by construction: the fee is only added by the NEW-SIGNUP checkout, never
 * retrofitted onto live subscriptions.
 *
 * Pure module (no server imports) so the onboarding order summary, a
 * client component, can run the same detection the checkout route bills
 * from.
 */

import { resolveBusinessCountry } from "./business-country";

/** Flat monthly surcharge, all tiers ($9.99/mo). */
export const MEXICO_MESSAGING_FEE_MONTHLY_CENTS = 999;

/**
 * Product name on the Stripe line item, the customer-visible label on
 * checkout, invoices, and the billing portal. Also the sentinel other code
 * can use to find the fee line on an invoice (same pattern as
 * CANADA_MESSAGING_FEE_NAME).
 */
export const MEXICO_MESSAGING_FEE_NAME = "Mexican messaging surcharge";

/**
 * True when the signup resolves to Mexico: a +52-shaped owner phone is
 * authoritative, else the Mexican browser-timezone fallback. Inconclusive
 * signals ⇒ not Mexican (fee skipped, US profile). See
 * resolveBusinessCountry for the full three-way rule.
 */
export function isMexicanBusiness(input: {
  phone?: string | null;
  timezone?: string | null;
}): boolean {
  return resolveBusinessCountry(input) === "MX";
}
