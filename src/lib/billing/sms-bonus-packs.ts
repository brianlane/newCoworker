/**
 * SMS bonus ("top-up") pack catalog.
 *
 * A pack is a one-time Stripe Price that grants a fixed number of bonus
 * outbound texts when `checkout.session.completed` fires with metadata:
 *   { checkoutKind: "sms_bonus_texts", businessId, smsTexts }
 *
 * Grants are applied by `apply_sms_bonus_grant_from_checkout` in the Stripe
 * webhook (`src/app/api/webhooks/stripe/route.ts`). Bonus texts are consumed
 * by `try_reserve_sms_outbound_slot` only AFTER the plan's monthly cap is
 * exhausted. Expiry is `max(period_end, purchased_at + 30d)` and
 * refund/dispute-lost triggers clawback — all mirroring
 * `src/lib/billing/voice-bonus-packs.ts`, including the pricing contract:
 *
 *   1. Explicit per-pack cents override (`STRIPE_SMS_BONUS_<N>_CENTS`).
 *   2. `SMS_BONUS_USD_PER_TEXT` × pack texts.
 *   3. The documented $0.02/text default when neither is set.
 *
 * A pack is available only when its `STRIPE_SMS_BONUS_<N>_PRICE_ID` env var
 * is set — missing IDs fail closed (hidden from the UI, rejected by the API).
 */

export const SMS_BONUS_PACK_IDS = ["texts_500", "texts_2000", "texts_10000"] as const;

export type SmsBonusPackId = (typeof SMS_BONUS_PACK_IDS)[number];

export type SmsBonusPack = {
  id: SmsBonusPackId;
  texts: number;
  priceCents: number;
  priceUsd: number;
  /** Effective $/text for this pack (priceUsd / texts), for display/compare. */
  effectiveUsdPerText: number;
  priceId: string;
  label: string;
  description: string;
};

const DEFAULT_USD_PER_TEXT = 0.02;

const PACK_DEFS: ReadonlyArray<{
  id: SmsBonusPackId;
  texts: number;
  priceIdEnv: string;
  priceCentsEnv: string;
}> = [
  {
    id: "texts_500",
    texts: 500,
    priceIdEnv: "STRIPE_SMS_BONUS_500_PRICE_ID",
    priceCentsEnv: "STRIPE_SMS_BONUS_500_CENTS"
  },
  {
    id: "texts_2000",
    texts: 2000,
    priceIdEnv: "STRIPE_SMS_BONUS_2000_PRICE_ID",
    priceCentsEnv: "STRIPE_SMS_BONUS_2000_CENTS"
  },
  {
    id: "texts_10000",
    texts: 10000,
    priceIdEnv: "STRIPE_SMS_BONUS_10000_PRICE_ID",
    priceCentsEnv: "STRIPE_SMS_BONUS_10000_CENTS"
  }
];

/**
 * Fallback USD/text used when a pack has no explicit cents override. Read
 * from `SMS_BONUS_USD_PER_TEXT`; falls back to the documented $0.02/text
 * default when unset or malformed.
 */
export function getSmsBonusUsdPerText(): number {
  const raw = process.env.SMS_BONUS_USD_PER_TEXT;
  if (!raw) return DEFAULT_USD_PER_TEXT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USD_PER_TEXT;
  return parsed;
}

function readPositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolvePriceCents(def: (typeof PACK_DEFS)[number], usdPerText: number): number {
  const override = readPositiveInt(process.env[def.priceCentsEnv]);
  if (override !== null) return override;
  return Math.round(def.texts * usdPerText * 100);
}

function buildPack(def: (typeof PACK_DEFS)[number], priceId: string, usdPerText: number): SmsBonusPack {
  const priceCents = resolvePriceCents(def, usdPerText);
  const priceUsd = priceCents / 100;
  return {
    id: def.id,
    texts: def.texts,
    priceCents,
    priceUsd,
    effectiveUsdPerText: priceUsd / def.texts,
    priceId,
    label: `${def.texts.toLocaleString("en-US")} texts`,
    description: `Adds ${def.texts.toLocaleString("en-US")} bonus outbound texts on top of your plan's monthly allowance.`
  };
}

/** Packs with a configured Stripe Price ID. Empty array ⇒ top-up UI hides. */
export function listSmsBonusPacks(): SmsBonusPack[] {
  const usdPerText = getSmsBonusUsdPerText();
  const out: SmsBonusPack[] = [];
  for (const def of PACK_DEFS) {
    const priceId = process.env[def.priceIdEnv];
    if (!priceId) continue;
    out.push(buildPack(def, priceId, usdPerText));
  }
  return out;
}

/**
 * Looks up a single pack by id. Returns `null` if the id is unknown or the
 * pack's Price ID env var is not configured (fail closed at the API boundary).
 */
export function getSmsBonusPack(id: string): SmsBonusPack | null {
  const def = PACK_DEFS.find((p) => p.id === id);
  if (!def) return null;
  const priceId = process.env[def.priceIdEnv];
  if (!priceId) return null;
  return buildPack(def, priceId, getSmsBonusUsdPerText());
}
