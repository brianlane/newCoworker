/**
 * Voice bonus ("top-up") pack catalog.
 *
 * A pack is a one-time Stripe Price that grants a fixed number of bonus voice
 * seconds when `checkout.session.completed` fires with metadata:
 *   { checkoutKind: "voice_bonus_seconds", businessId, voiceSeconds }
 *
 * Grants are applied by `apply_voice_bonus_grant_from_checkout` in the Stripe
 * webhook (`src/app/api/webhooks/stripe/route.ts`). Expiry is `max(period_end,
 * purchased_at + 30d)` and refund/dispute-lost triggers clawback.
 *
 * ## Pricing contract (single source of truth)
 *
 * Stripe Prices are immutable by id — once created, a Price's `unit_amount`
 * never changes. That means the pack's displayed USD price and what Stripe
 * actually charges only diverge if an operator ships a mismatched config:
 * new Price IDs pointing at different amounts than what env implies.
 *
 * Pricing is resolved per pack with this precedence:
 *   1. Explicit per-pack cents override (`STRIPE_VOICE_BONUS_<NMIN>MIN_CENTS`).
 *      Use this when the catalog has non-uniform rates (e.g. marketing-friendly
 *      `.99` pricing that doesn't share a single $/min).
 *   2. `VOICE_BONUS_USD_PER_MINUTE` × pack minutes, which keeps a single rate
 *      across all packs for simpler ops.
 *   3. The documented $0.43/min default when neither is set.
 *
 * We treat env as the single source of truth and enforce the contract at the
 * operator boundary: whenever any pack's effective price changes, the
 * corresponding `STRIPE_VOICE_BONUS_*MIN_PRICE_ID` MUST be rotated in the same
 * deploy to a Stripe Price whose `unit_amount` matches the new cents value.
 * This keeps render-time compute at zero (no Stripe round-trip per billing
 * page load) while still guaranteeing UI ≡ charge as long as deploys are
 * done correctly.
 *
 * A pack is considered available only when its `STRIPE_VOICE_BONUS_<NMIN>MIN_
 * PRICE_ID` env var is set — missing IDs fail closed (pack is hidden from the
 * UI and rejected by the API) so a partial rollout never creates a broken
 * purchase button.
 */

export const VOICE_BONUS_PACK_IDS = ["min_30", "min_120", "min_600"] as const;

export type VoiceBonusPackId = (typeof VOICE_BONUS_PACK_IDS)[number];

export type VoiceBonusPack = {
  id: VoiceBonusPackId;
  minutes: number;
  seconds: number;
  priceCents: number;
  priceUsd: number;
  /** Effective $/min for this pack (priceUsd / minutes), for display/compare. */
  effectiveUsdPerMinute: number;
  priceId: string;
  label: string;
  description: string;
};

const DEFAULT_USD_PER_MINUTE = 0.43;

const PACK_DEFS: ReadonlyArray<{
  id: VoiceBonusPackId;
  minutes: number;
  priceIdEnv: string;
  priceCentsEnv: string;
}> = [
  {
    id: "min_30",
    minutes: 30,
    priceIdEnv: "STRIPE_VOICE_BONUS_30MIN_PRICE_ID",
    priceCentsEnv: "STRIPE_VOICE_BONUS_30MIN_CENTS"
  },
  {
    id: "min_120",
    minutes: 120,
    priceIdEnv: "STRIPE_VOICE_BONUS_120MIN_PRICE_ID",
    priceCentsEnv: "STRIPE_VOICE_BONUS_120MIN_CENTS"
  },
  {
    id: "min_600",
    minutes: 600,
    priceIdEnv: "STRIPE_VOICE_BONUS_600MIN_PRICE_ID",
    priceCentsEnv: "STRIPE_VOICE_BONUS_600MIN_CENTS"
  }
];

/**
 * Fallback USD/min used when a pack has no explicit cents override. Read from
 * `VOICE_BONUS_USD_PER_MINUTE`; falls back to the documented $0.43/min default
 * when unset or malformed.
 */
export function getVoiceBonusUsdPerMinute(): number {
  const raw = process.env.VOICE_BONUS_USD_PER_MINUTE;
  if (!raw) return DEFAULT_USD_PER_MINUTE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USD_PER_MINUTE;
  return parsed;
}

function readPositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolvePriceCents(def: (typeof PACK_DEFS)[number], usdPerMinute: number): number {
  const override = readPositiveInt(process.env[def.priceCentsEnv]);
  if (override !== null) return override;
  return Math.round(def.minutes * usdPerMinute * 100);
}

function buildPack(def: (typeof PACK_DEFS)[number], priceId: string, usdPerMinute: number): VoiceBonusPack {
  const priceCents = resolvePriceCents(def, usdPerMinute);
  const priceUsd = priceCents / 100;
  return {
    id: def.id,
    minutes: def.minutes,
    seconds: def.minutes * 60,
    priceCents,
    priceUsd,
    effectiveUsdPerMinute: priceUsd / def.minutes,
    priceId,
    label: `${def.minutes} minutes`,
    description: `Adds ${def.minutes} voice minutes (${def.minutes * 60} seconds) of AI talk time.`
  };
}

/** Packs with a configured Stripe Price ID. Empty array ⇒ top-up UI hides. */
export function listVoiceBonusPacks(): VoiceBonusPack[] {
  const usdPerMinute = getVoiceBonusUsdPerMinute();
  const out: VoiceBonusPack[] = [];
  for (const def of PACK_DEFS) {
    const priceId = process.env[def.priceIdEnv];
    if (!priceId) continue;
    out.push(buildPack(def, priceId, usdPerMinute));
  }
  return out;
}

/**
 * Looks up a single pack by id. Returns `null` if the id is unknown or the
 * pack's Price ID env var is not configured (fail closed at the API boundary).
 */
export function getVoiceBonusPack(id: string): VoiceBonusPack | null {
  const def = PACK_DEFS.find((p) => p.id === id);
  if (!def) return null;
  const priceId = process.env[def.priceIdEnv];
  if (!priceId) return null;
  return buildPack(def, priceId, getVoiceBonusUsdPerMinute());
}

/**
 * Best (lowest) effective $/min across the configured packs. Used by the UI
 * header to show a truthful "from $X / min" when packs have non-uniform rates.
 * Returns the fallback rate when no packs are configured.
 */
export function getVoiceBonusBestUsdPerMinute(packs: VoiceBonusPack[]): number {
  if (packs.length === 0) return getVoiceBonusUsdPerMinute();
  return packs.reduce((min, p) => (p.effectiveUsdPerMinute < min ? p.effectiveUsdPerMinute : min), Infinity);
}
