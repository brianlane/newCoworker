/**
 * Owner-facing plan-change copy helpers.
 *
 * Entitlements (`businesses.tier`) flip immediately. Hardware stays on the
 * current Hostinger box while that box still has prepaid time, and only
 * migrates or resizes at lapse. Confirm, success-banner, and billing-line
 * copy all branch on that story so the UI cannot promise a fresh VPS on
 * every plan change.
 */

import { boxHasPaidTimeLeft, shouldMigrateHardwareForPlanChange } from "@/lib/billing/plan-change-hardware";

export type PlanChangeHardwareStory =
  | "same_tier"
  | "keep_until_lapse"
  | "keep_same_hardware"
  | "migrate_now";

export type PlanChangeConfirmHardwareKey =
  | "confirmSameTier"
  | "confirmKeepDated"
  | "confirmKeepGeneric"
  | "confirmKeepSameHardware"
  | "confirmMigrate";

export type PlanChangeSuccessBannerKey =
  | "planChangedKeepDated"
  | "planChangedKeepGeneric"
  | "planChangedMigrate";

export function planChangeHardwareStory(input: {
  currentTier: "starter" | "standard";
  selectedTier: "starter" | "standard";
  vpsSizePin?: string | null;
  expiresAt?: string | null;
  hasLiveBox?: boolean;
  nowMs?: number;
}): PlanChangeHardwareStory {
  if (input.currentTier === input.selectedTier) return "same_tier";
  const migrate = shouldMigrateHardwareForPlanChange({
    oldTier: input.currentTier,
    newTier: input.selectedTier,
    vpsSizePin: input.vpsSizePin ?? null,
    termAlignment: false,
    expiresAt: input.expiresAt,
    hasLiveBox: input.hasLiveBox,
    nowMs: input.nowMs
  });
  if (migrate) return "migrate_now";
  if (input.hasLiveBox !== false && boxHasPaidTimeLeft(input.expiresAt, input.nowMs)) {
    return "keep_until_lapse";
  }
  return "keep_same_hardware";
}

/** Confirm-sheet key for the hardware paragraph (literal catalog keys). */
export function planChangeConfirmHardwareKey(
  input: Parameters<typeof planChangeHardwareStory>[0]
): PlanChangeConfirmHardwareKey {
  const story = planChangeHardwareStory(input);
  if (story === "same_tier") return "confirmSameTier";
  if (story === "migrate_now") return "confirmMigrate";
  if (story === "keep_same_hardware") return "confirmKeepSameHardware";
  return parseablePaidThroughIso(input.expiresAt, input.nowMs)
    ? "confirmKeepDated"
    : "confirmKeepGeneric";
}

export function planChangeWarnsStarterWebhooks(
  currentTier: "starter" | "standard",
  selectedTier: "starter" | "standard"
): boolean {
  return selectedTier === "starter" && currentTier !== "starter";
}

/** True when a parseable expires_at is still in the future. */
export function parseablePaidThroughIso(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (expiresAt == null || expiresAt === "") return null;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  if (ms <= nowMs) return null;
  return expiresAt;
}

export function formatPlanChangePaidThroughDate(
  expiresAt: string,
  locale: string = "en"
): string | null {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  }).format(new Date(ms));
}

/**
 * Success-banner key after Stripe Checkout returns. We do not know from
 * `?planChanged=1` whether the customer changed tier or only period, so
 * this follows prepaid time: keep-dated when we can name the day, keep
 * generic when expiry is unknown, migrate when the box has already lapsed.
 */
export function planChangeSuccessBannerKey(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): PlanChangeSuccessBannerKey {
  if (!boxHasPaidTimeLeft(expiresAt, nowMs)) return "planChangedMigrate";
  return parseablePaidThroughIso(expiresAt, nowMs) ? "planChangedKeepDated" : "planChangedKeepGeneric";
}

export function showServerPrepaidLine(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
  hasLiveBox: boolean = true
): boolean {
  if (!hasLiveBox) return false;
  return boxHasPaidTimeLeft(expiresAt, nowMs);
}

export function entitlementBillingMismatch(
  businessTier: string | null | undefined,
  subscriptionTier: string | null | undefined
): boolean {
  if (!businessTier || !subscriptionTier) return false;
  return businessTier !== subscriptionTier;
}
