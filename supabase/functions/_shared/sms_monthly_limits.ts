/**
 * Canonical monthly SMS caps for non-enterprise tiers, denominated in TEXT
 * UNITS (UTC calendar month; sum of `daily_usage.sms_text_units`): one unit
 * per carrier part for SMS, 2.2 for an MMS (see _shared/sms_text_units.ts).
 * Keep in sync with Postgres `nonenterprise_monthly_sms_cap` /
 * `try_reserve_sms_outbound_slot` in migrations and with app `TIER_LIMITS`
 * via `limits.ts`.
 */
// Re-denominated messages -> units in the weighted_sms_metering migration
// (Aug 2026): Telnyx bills per part and the fleet averages ~2.5 parts per
// message, so the old message caps admitted ~5x the intended spend. The unit
// caps hold the tier-economics worst-case dollars: starter 150 units ~=
// $1.32/mo and standard 5,000 units ~= $43.94/mo at the measured
// $0.008787/part, vs the $1.59 / $47.70 the canvas priced the tiers against.
// (History: starter messages 750 -> 500 -> 100 in the Jul 2026 relaunch.)
export const SMS_MONTHLY_CAP_STARTER = 150;
export const SMS_MONTHLY_CAP_STANDARD = 5000;
// Mexican non-enterprise tenants are clamped to 100/month on EVERY tier:
// their US +1 DID texts +52 as international A2P at the Telnyx list rate of
// $0.091/part (vs the blended US rate the tiers were priced on), so the
// standard cap cannot be flat-fee-covered; WhatsApp carries Mexican customer
// volume instead. Now denominated in units like the tier caps (deliberately
// tighter: ~40 average-length messages). Enforced in Postgres by
// try_reserve_sms_outbound_slot via business_phone_country (mx_sms_cap
// migration); keep this constant in sync with that clamp. Revisit when the
// Phase 2 destination multipliers land.
export const SMS_MONTHLY_CAP_MX = 100;
