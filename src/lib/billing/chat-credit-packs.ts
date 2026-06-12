/**
 * Gemini (chat-model) spend-credit pack catalog.
 *
 * A pack is a one-time Stripe Price that grants purchased spend credit which
 * RAISES the shared chat-model cap (owner dashboard chat + SMS, see
 * `supabase/functions/_shared/chat_spend_cap.ts`) while active. Checkout
 * metadata:
 *   { checkoutKind: "chat_credit_micros", businessId, creditMicros }
 *
 * Grants are applied by `apply_chat_credit_grant_from_checkout` in the Stripe
 * webhook; cap checks read `chat_active_credit_micros(business)` and add it
 * to the base cap. Expiry is `max(period_end, purchased_at + 30d)`;
 * refund/dispute-lost triggers clawback. Same fail-closed env contract as
 * `src/lib/billing/voice-bonus-packs.ts`: a pack only exists when its
 * `STRIPE_CHAT_CREDIT_<N>USD_PRICE_ID` env var is set, and the charged price
 * defaults to the credit's face value (override via
 * `STRIPE_CHAT_CREDIT_<N>USD_CENTS`).
 */

export const CHAT_CREDIT_PACK_IDS = ["usd_5", "usd_10", "usd_25"] as const;

export type ChatCreditPackId = (typeof CHAT_CREDIT_PACK_IDS)[number];

export type ChatCreditPack = {
  id: ChatCreditPackId;
  creditUsd: number;
  creditMicros: number;
  priceCents: number;
  priceUsd: number;
  priceId: string;
  label: string;
  description: string;
};

const PACK_DEFS: ReadonlyArray<{
  id: ChatCreditPackId;
  creditUsd: number;
  priceIdEnv: string;
  priceCentsEnv: string;
}> = [
  {
    id: "usd_5",
    creditUsd: 5,
    priceIdEnv: "STRIPE_CHAT_CREDIT_5USD_PRICE_ID",
    priceCentsEnv: "STRIPE_CHAT_CREDIT_5USD_CENTS"
  },
  {
    id: "usd_10",
    creditUsd: 10,
    priceIdEnv: "STRIPE_CHAT_CREDIT_10USD_PRICE_ID",
    priceCentsEnv: "STRIPE_CHAT_CREDIT_10USD_CENTS"
  },
  {
    id: "usd_25",
    creditUsd: 25,
    priceIdEnv: "STRIPE_CHAT_CREDIT_25USD_PRICE_ID",
    priceCentsEnv: "STRIPE_CHAT_CREDIT_25USD_CENTS"
  }
];

function readPositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function buildPack(def: (typeof PACK_DEFS)[number], priceId: string): ChatCreditPack {
  const priceCents = readPositiveInt(process.env[def.priceCentsEnv]) ?? def.creditUsd * 100;
  const priceUsd = priceCents / 100;
  return {
    id: def.id,
    creditUsd: def.creditUsd,
    creditMicros: def.creditUsd * 1_000_000,
    priceCents,
    priceUsd,
    priceId,
    label: `$${def.creditUsd} AI credit`,
    description: `Raises this period's AI chat budget by $${def.creditUsd} so replies stay on the fast cloud model.`
  };
}

/** Packs with a configured Stripe Price ID. Empty array ⇒ top-up UI hides. */
export function listChatCreditPacks(): ChatCreditPack[] {
  const out: ChatCreditPack[] = [];
  for (const def of PACK_DEFS) {
    const priceId = process.env[def.priceIdEnv];
    if (!priceId) continue;
    out.push(buildPack(def, priceId));
  }
  return out;
}

/**
 * Looks up a single pack by id. Returns `null` if the id is unknown or the
 * pack's Price ID env var is not configured (fail closed at the API boundary).
 */
export function getChatCreditPack(id: string): ChatCreditPack | null {
  const def = PACK_DEFS.find((p) => p.id === id);
  if (!def) return null;
  const priceId = process.env[def.priceIdEnv];
  if (!priceId) return null;
  return buildPack(def, priceId);
}
