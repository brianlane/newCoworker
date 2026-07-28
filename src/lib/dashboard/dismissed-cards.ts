/**
 * Per-user dismissal of dashboard promo cards (the starter-flow installers on
 * the AiFlows page). Rows in `user_dismissed_cards` keyed by (auth user id,
 * card key), modeled on `user_sidebar_items`: scoped to the signed-in user
 * rather than the business, so an admin in view-as hides the card from their
 * own dashboard and never from the tenant's.
 *
 * Dismissing hides the card, nothing else. An installed flow keeps running,
 * and the flow itself stays reachable from the AiFlows list and the public
 * library, so a dismissal can never lose a tenant an automation.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Every dismissible card, by stable key. Keys are persisted, so renaming one
 * un-dismisses the card for everyone who had hidden it; add, don't rename.
 */
export const DISMISSIBLE_CARDS = [
  "aiflows.review_request",
  "aiflows.document_receipt",
  "aiflows.new_lead_intake"
] as const;

export type DismissibleCardKey = (typeof DISMISSIBLE_CARDS)[number];

const CARD_KEYS: ReadonlySet<string> = new Set(DISMISSIBLE_CARDS);

export function isDismissibleCardKey(key: string): key is DismissibleCardKey {
  return CARD_KEYS.has(key);
}

/**
 * The card keys this user has hidden. Read failures degrade to "nothing is
 * dismissed" (warn-logged): showing a card the user hid is a far smaller
 * failure than breaking the page it sits on.
 */
export async function listDismissedCardKeys(
  userId: string,
  client?: SupabaseClient
): Promise<DismissibleCardKey[]> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("user_dismissed_cards")
      .select("card_key")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    // Retired keys left in the table are dropped rather than surfaced.
    return (data ?? [])
      .map((row) => (row as { card_key: string }).card_key)
      .filter(isDismissibleCardKey);
  } catch (err) {
    logger.warn("listDismissedCardKeys failed; showing every card", {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

/** Hide a card for this user. Idempotent: re-dismissing is a no-op upsert. */
export async function dismissCard(
  userId: string,
  cardKey: string,
  client?: SupabaseClient
): Promise<void> {
  if (!isDismissibleCardKey(cardKey)) {
    throw new Error(`dismissCard: unknown card key "${cardKey}"`);
  }
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("user_dismissed_cards")
    .upsert({ user_id: userId, card_key: cardKey }, { onConflict: "user_id,card_key" });
  if (error) throw new Error(`dismissCard: ${error.message}`);
}

/** Bring a dismissed card back (the undo path). */
export async function restoreCard(
  userId: string,
  cardKey: string,
  client?: SupabaseClient
): Promise<void> {
  if (!isDismissibleCardKey(cardKey)) {
    throw new Error(`restoreCard: unknown card key "${cardKey}"`);
  }
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("user_dismissed_cards")
    .delete()
    .eq("user_id", userId)
    .eq("card_key", cardKey);
  if (error) throw new Error(`restoreCard: ${error.message}`);
}
