/**
 * Canonical monthly SMS caps for non-enterprise tiers (UTC calendar month; sum of `daily_usage.sms_sent`).
 * Keep in sync with Postgres `nonenterprise_monthly_sms_cap` / `try_reserve_sms_outbound_slot` in migrations
 * and with app `TIER_LIMITS` via `limits.ts`.
 */
// Starter trimmed 750 → 500 → 100 in the Jul 2026 tier relaunch (starter
// margin rescue: at the blended ~$0.0159/msg Telnyx rate, 100 msgs caps the
// worst-case SMS exposure at ~$1.59/mo so a full-cap starter can no longer
// sink the tier); keep in sync with the `nonenterprise_monthly_sms_cap`
// migration.
export const SMS_MONTHLY_CAP_STARTER = 100;
export const SMS_MONTHLY_CAP_STANDARD = 3000;
