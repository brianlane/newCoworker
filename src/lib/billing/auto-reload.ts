/**
 * Auto-reload for usage packs: the pure decision layer.
 *
 * A tenant picks a pack and a threshold per family. When their remaining
 * capacity falls below that threshold we charge the card they authorized and
 * grant the pack, the same way Telnyx auto-recharges a balance and Google AI
 * Studio auto-reloads Gemini credit.
 *
 * Everything here is I/O free so the sweep, the settings route, and the UI
 * share one source of truth for units, bounds, and validation. Balance
 * reading lives in `auto-reload-sweep.ts`; charging lives in the Stripe layer.
 *
 * Units are CANONICAL INTEGERS throughout: seconds for voice, texts for SMS,
 * micro-USD for chat. The tenant sees minutes / texts / dollars, and the
 * conversion happens at the edges through `toDisplayUnits` /
 * `fromDisplayUnits`. Storing display units would mean rounding a dollar
 * threshold into micros on every read.
 */

import { getVoiceBonusPack } from "@/lib/billing/voice-bonus-packs";
import { getSmsBonusPack } from "@/lib/billing/sms-bonus-packs";
import { getChatCreditPack } from "@/lib/billing/chat-credit-packs";
// Re-exported from a dependency-free module so the client component can use
// the exact same conversion (a second copy is what drifted before).
export { fromDisplayUnits, toDisplayUnits } from "@/lib/billing/auto-reload-units";

export const AUTO_RELOAD_CATEGORIES = ["voice", "sms", "chat"] as const;

export type AutoReloadCategory = (typeof AUTO_RELOAD_CATEGORIES)[number];

export function isAutoReloadCategory(value: unknown): value is AutoReloadCategory {
  return (
    typeof value === "string" &&
    (AUTO_RELOAD_CATEGORIES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Threshold bounds in canonical units.
 *
 * The voice maximum equals the largest pack (600 minutes) rather than
 * exceeding it, because a threshold at or above the chosen pack's grant size
 * can never be cleared by buying that pack: the sweep would fire, charge,
 * still read below threshold, and fire again next tick. `validateAutoReload`
 * enforces the per-pack version of that rule; these bounds are the coarse
 * outer limits the UI renders.
 */
export const AUTO_RELOAD_THRESHOLD_BOUNDS: Record<
  AutoReloadCategory,
  { min: number; max: number; default: number }
> = {
  // seconds: 5 minutes .. 600 minutes, default 15 minutes
  voice: { min: 300, max: 36_000, default: 900 },
  // texts
  sms: { min: 25, max: 5_000, default: 100 },
  // micro-USD: $1 .. $50, default $2
  chat: { min: 1_000_000, max: 50_000_000, default: 2_000_000 }
};

/**
 * Minutes between charges for one tenant and family.
 *
 * Voice is the fastest burner (a single answered call can eat ten minutes) so
 * it gets the shortest cooldown. Chat credit is the slowest to genuinely need
 * a second top-up in one period, because credit raises the cap rather than
 * being consumed, so it gets the longest.
 */
export const AUTO_RELOAD_DEFAULT_COOLDOWN_MINUTES: Record<AutoReloadCategory, number> = {
  voice: 30,
  sms: 120,
  chat: 120
};

export const AUTO_RELOAD_COOLDOWN_BOUNDS = { min: 5, max: 1_440 } as const;

/** Ceiling on a tenant-set monthly limit, so a typo cannot authorize $50k. */
export const AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS = 500_000;

/**
 * Chat credit RAISES the period spend cap and is never decremented by usage,
 * so a second reload in one period stacks permanently for that period whether
 * or not the credit gets spent. Voice seconds and SMS texts are real
 * consumable balances that carry to the next period, so an unused reload
 * there is deferred value rather than waste. Chat therefore has to declare a
 * monthly ceiling before it can arm.
 */
export const AUTO_RELOAD_REQUIRES_MONTHLY_LIMIT: Record<AutoReloadCategory, boolean> = {
  voice: false,
  sms: false,
  chat: true
};

export type ResolvedAutoReloadPack = {
  packId: string;
  /** Grant size in canonical units (seconds / texts / micros). */
  grantUnits: number;
  priceCents: number;
  priceId: string;
  label: string;
};

/**
 * Catalog lookup, fail-closed exactly like the checkout routes: a pack whose
 * `STRIPE_*_PRICE_ID` env var is unset does not exist. An auto-reload rule
 * pointing at an unconfigured pack must refuse to arm rather than silently
 * never firing.
 */
export function resolveAutoReloadPack(
  category: AutoReloadCategory,
  packId: string
): ResolvedAutoReloadPack | null {
  const id = packId.trim();
  if (!id) return null;

  if (category === "voice") {
    const pack = getVoiceBonusPack(id);
    if (!pack) return null;
    return {
      packId: pack.id,
      grantUnits: pack.seconds,
      priceCents: pack.priceCents,
      priceId: pack.priceId,
      label: pack.label
    };
  }

  if (category === "sms") {
    const pack = getSmsBonusPack(id);
    if (!pack) return null;
    return {
      packId: pack.id,
      grantUnits: pack.texts,
      priceCents: pack.priceCents,
      priceId: pack.priceId,
      label: pack.label
    };
  }

  const pack = getChatCreditPack(id);
  if (!pack) return null;
  return {
    packId: pack.id,
    grantUnits: pack.creditMicros,
    priceCents: pack.priceCents,
    priceId: pack.priceId,
    label: pack.label
  };
}

export type AutoReloadValidationError =
  | "unknown_pack"
  | "threshold_out_of_range"
  | "threshold_not_below_pack"
  | "monthly_limit_below_pack_price"
  | "monthly_limit_out_of_range"
  | "monthly_limit_required";

export type AutoReloadSettingsInput = {
  category: AutoReloadCategory;
  enabled: boolean;
  packId: string;
  thresholdUnits: number;
  monthlyLimitCents: number | null;
};

export type AutoReloadValidationResult =
  | { ok: true; pack: ResolvedAutoReloadPack }
  | { ok: false; error: AutoReloadValidationError };

/**
 * Validate a settings write.
 *
 * Deliberately runs regardless of `enabled`: a tenant must not be able to
 * save a configuration that would misbehave and then flip it on later through
 * a path that skips validation. The one rule that IS conditional on `enabled`
 * is the chat monthly-limit requirement, since a disabled chat rule spends
 * nothing.
 */
export function validateAutoReload(input: AutoReloadSettingsInput): AutoReloadValidationResult {
  const pack = resolveAutoReloadPack(input.category, input.packId);
  if (!pack) return { ok: false, error: "unknown_pack" };

  const bounds = AUTO_RELOAD_THRESHOLD_BOUNDS[input.category];
  if (
    !Number.isInteger(input.thresholdUnits) ||
    input.thresholdUnits < bounds.min ||
    input.thresholdUnits > bounds.max
  ) {
    return { ok: false, error: "threshold_out_of_range" };
  }

  // The anti-loop invariant. A reload has to lift the balance strictly above
  // the threshold, or the next sweep tick reads below threshold again and
  // charges again, forever.
  if (input.thresholdUnits >= pack.grantUnits) {
    return { ok: false, error: "threshold_not_below_pack" };
  }

  if (input.monthlyLimitCents !== null) {
    if (
      !Number.isInteger(input.monthlyLimitCents) ||
      input.monthlyLimitCents <= 0 ||
      input.monthlyLimitCents > AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS
    ) {
      return { ok: false, error: "monthly_limit_out_of_range" };
    }
    // A limit below one pack's price is not a budget, it is an off switch
    // that looks like a budget: every claim would refuse and the tenant
    // would see an armed toggle that never fires.
    if (input.monthlyLimitCents < pack.priceCents) {
      return { ok: false, error: "monthly_limit_below_pack_price" };
    }
  } else if (input.enabled && AUTO_RELOAD_REQUIRES_MONTHLY_LIMIT[input.category]) {
    return { ok: false, error: "monthly_limit_required" };
  }

  return { ok: true, pack };
}

/**
 * Below-threshold test. Split out from the sweep so the trigger arithmetic is
 * directly testable without a database.
 */
export function isBelowThreshold(balanceUnits: number, thresholdUnits: number): boolean {
  return balanceUnits < thresholdUnits;
}

/**
 * The monthly-limit window key.
 *
 * Deliberately the UTC CALENDAR month, and deliberately no longer the same
 * window as the usage meters. This bounds how much money auto-reload may
 * charge a card without asking, which is a spend guardrail rather than a plan
 * allowance: a tenant reasons about it in calendar months, and a plan change
 * that moves their billing anchor must not silently hand them a second
 * month's charging budget.
 *
 * The usage windows moved to the Stripe anchor in
 * `sms_window_anchored_to_billing_period`; this one stayed put on purpose.
 * (It could not simply follow the raw Stripe period either: a prepaid 24
 * month tenant's period is the whole term, so that would be one budget
 * window spanning two years.)
 */
export function autoReloadMonthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The claim bucket a given moment falls in.
 *
 * Two sweep ticks inside the same cooldown window produce the same key, and
 * the unique index on it is what makes a concurrent double-charge impossible.
 * The cooldown must come from the stored rule rather than the caller, so a
 * tenant editing their cooldown cannot shift a boundary and buy an extra
 * charge in the transition.
 */
export function buildAttemptKey(params: {
  businessId: string;
  category: AutoReloadCategory;
  cooldownMinutes: number;
  now: Date;
}): string {
  const windowSec = Math.max(1, Math.round(params.cooldownMinutes * 60));
  const bucket = Math.floor(params.now.getTime() / 1000 / windowSec);
  return `${params.businessId}:${params.category}:${bucket}`;
}

export type AutoReloadFailureKind =
  | "requires_action"
  | "hard_decline"
  | "soft_decline"
  | "no_payment_method"
  | "api_error";

/** Declines that will not succeed on a retry, so they count toward suspension. */
const HARD_DECLINE_CODES = new Set([
  "card_declined",
  "expired_card",
  "incorrect_number",
  "invalid_account",
  "card_not_supported",
  "pickup_card",
  "lost_card",
  "stolen_card"
]);

/**
 * Classify a Stripe charge failure.
 *
 * `authentication_required` is deliberately NOT a decline. It means the
 * issuer wants the cardholder present for 3DS, which is normal for many
 * non-US cards. Counting it toward `consecutive_failures` would auto-disable
 * auto-reload for well-behaved European and Latin American tenants after
 * three ordinary bank challenges.
 */
export function classifyChargeFailure(err: unknown): {
  kind: AutoReloadFailureKind;
  code: string | null;
  message: string;
} {
  const e = err as
    | { code?: unknown; decline_code?: unknown; message?: unknown; type?: unknown }
    | null
    | undefined;
  const code = typeof e?.code === "string" ? e.code : null;
  const declineCode = typeof e?.decline_code === "string" ? e.decline_code : null;
  const message = typeof e?.message === "string" ? e.message : String(err);

  if (code === "authentication_required") {
    return { kind: "requires_action", code, message };
  }
  if (code === "payment_method_unactivated" || code === "missing_payment_method") {
    return { kind: "no_payment_method", code, message };
  }
  if (code === "card_declined") {
    // insufficient_funds and generic_decline can clear on their own, so they
    // are soft: retry next cooldown rather than burning a suspension strike.
    if (declineCode === "insufficient_funds" || declineCode === "generic_decline") {
      return { kind: "soft_decline", code: declineCode, message };
    }
    return { kind: "hard_decline", code: declineCode ?? code, message };
  }
  if (code && HARD_DECLINE_CODES.has(code)) {
    return { kind: "hard_decline", code, message };
  }
  if (typeof e?.type === "string" && e.type === "StripeCardError") {
    return { kind: "soft_decline", code, message };
  }
  return { kind: "api_error", code, message };
}

/** Consecutive hard failures before a rule is switched off entirely. */
export const AUTO_RELOAD_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Platform kill switch, ON by default.
 *
 * It shipped fail-closed so the feature could land dormant while the money
 * path was verified. That is done, so an unset variable now means enabled:
 * a flag nobody sets is a feature nobody has.
 *
 * Only the literal string "0" turns it off. That is the emergency brake:
 * auto-reload charges cards with nobody watching, so being able to stop the
 * whole fleet with one environment variable, without waiting for a deploy, is
 * worth keeping.
 */
export function autoReloadPlatformEnabled(): boolean {
  return process.env.USAGE_PACK_AUTO_RELOAD_ENABLED !== "0";
}

/**
 * Platform ceiling a tenant's monthly limit is clamped to. Lets us cap fleet
 * exposure without editing every tenant's row.
 */
export function autoReloadPlatformMaxMonthlyCents(): number {
  const raw = process.env.USAGE_PACK_AUTO_RELOAD_MAX_SPEND_CENTS_PER_PERIOD;
  if (!raw) return AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS;
  }
  return Math.min(parsed, AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS);
}

/** Effective monthly ceiling: the tenant's own limit clamped by the platform. */
export function effectiveMonthlyLimitCents(tenantLimitCents: number | null): number {
  const platform = autoReloadPlatformMaxMonthlyCents();
  if (tenantLimitCents === null) return platform;
  return Math.min(tenantLimitCents, platform);
}
