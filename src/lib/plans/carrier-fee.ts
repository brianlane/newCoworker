/**
 * One-time 10DLC carrier-registration fee passed through to new tenants
 * (fleet economics Phase C3).
 *
 * The TCR/carrier fees we pay per new SMS campaign (brand registration,
 * vetting, three months of campaign fees upfront) are non-refundable to us,
 * so they are passed through at signup as a one-time checkout line item —
 * mirroring what competitors charge (Quo: $19.50).
 *
 * NON-REFUNDABLE: the 30-day money-back refund carves this amount out (see
 * `refund_latest_charge` in `lifecycle-executor.ts`), matching the checkout
 * disclosure copy.
 */
export const CARRIER_REGISTRATION_FEE_CENTS = 1950;

/**
 * Product name on the Stripe line item AND the sentinel used to find the fee
 * line on the first invoice at refund time. The two stay in sync by
 * construction: rename it here and the refund carve-out follows.
 */
export const CARRIER_REGISTRATION_FEE_NAME = "Carrier registration (10DLC)";
