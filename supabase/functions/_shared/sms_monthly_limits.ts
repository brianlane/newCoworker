/**
 * Canonical monthly SMS caps for non-enterprise tiers (UTC calendar month; sum of `daily_usage.sms_sent`).
 * Keep in sync with Postgres `nonenterprise_monthly_sms_cap` / `try_reserve_sms_outbound_slot` in migrations
 * and with app `TIER_LIMITS` via `limits.ts`.
 */
export const SMS_MONTHLY_CAP_STARTER = 750;
export const SMS_MONTHLY_CAP_STANDARD = 3000;
