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
 * All packs share the same effective rate (`VOICE_BONUS_USD_PER_MINUTE`, default
 * $0.43/min). A pack is considered available only when its `STRIPE_VOICE_BONUS_
 * <NMIN>MIN_PRICE_ID` env var is set — missing IDs fail closed (pack is hidden
 * from the UI and rejected by the API) so a partial rollout never creates a
 * broken purchase button.
 */

export const VOICE_BONUS_PACK_IDS = ["min_30", "min_120", "min_600"] as const;

export type VoiceBonusPackId = (typeof VOICE_BONUS_PACK_IDS)[number];

export type VoiceBonusPack = {
  id: VoiceBonusPackId;
  minutes: number;
  seconds: number;
  priceCents: number;
  priceUsd: number;
  priceId: string;
  label: string;
  description: string;
};

const DEFAULT_USD_PER_MINUTE = 0.43;

const PACK_DEFS: ReadonlyArray<{
  id: VoiceBonusPackId;
  minutes: number;
  priceEnv: string;
}> = [
  { id: "min_30", minutes: 30, priceEnv: "STRIPE_VOICE_BONUS_30MIN_PRICE_ID" },
  { id: "min_120", minutes: 120, priceEnv: "STRIPE_VOICE_BONUS_120MIN_PRICE_ID" },
  { id: "min_600", minutes: 600, priceEnv: "STRIPE_VOICE_BONUS_600MIN_PRICE_ID" }
];

/**
 * USD/min sold to tenants for bonus voice seconds. Read from
 * `VOICE_BONUS_USD_PER_MINUTE` so ops can tune pricing without a redeploy; falls
 * back to the documented $0.43/min default when unset.
 */
export function getVoiceBonusUsdPerMinute(): number {
  const raw = process.env.VOICE_BONUS_USD_PER_MINUTE;
  if (!raw) return DEFAULT_USD_PER_MINUTE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USD_PER_MINUTE;
  return parsed;
}

function buildPack(def: (typeof PACK_DEFS)[number], priceId: string, usdPerMinute: number): VoiceBonusPack {
  const priceCents = Math.round(def.minutes * usdPerMinute * 100);
  return {
    id: def.id,
    minutes: def.minutes,
    seconds: def.minutes * 60,
    priceCents,
    priceUsd: priceCents / 100,
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
    const priceId = process.env[def.priceEnv];
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
  const priceId = process.env[def.priceEnv];
  if (!priceId) return null;
  return buildPack(def, priceId, getVoiceBonusUsdPerMinute());
}
