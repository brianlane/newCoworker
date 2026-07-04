/**
 * Canonical monthly SMS caps for non-enterprise tiers (UTC calendar month; sum of `daily_usage.sms_sent`).
 * Keep in sync with Postgres `nonenterprise_monthly_sms_cap` / `try_reserve_sms_outbound_slot` in migrations
 * and with app `TIER_LIMITS` via `limits.ts`.
 */
// Starter trimmed 750 → 500 in the Jul 2026 tier relaunch (starter margin
// rescue); keep in sync with the `nonenterprise_monthly_sms_cap` migration.
export const SMS_MONTHLY_CAP_STARTER = 500;
export const SMS_MONTHLY_CAP_STANDARD = 3000;
