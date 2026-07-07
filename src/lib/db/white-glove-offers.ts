/**
 * Custom (admin-authored) white-glove offers — DB access layer.
 *
 * A row here is a bespoke, single-business deal: the admin names it and sets
 * a custom amount; the owner pays it via Stripe Checkout with inline
 * `price_data` (this row IS the pricing source of truth — never trust a
 * client-supplied amount). Lifecycle: open → paid (Stripe webhook) or
 * open → revoked (admin). See migration 20260803000000_white_glove_offers.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WhiteGloveOfferStatus = "open" | "paid" | "revoked";

export type WhiteGloveOfferRow = {
  id: string;
  business_id: string;
  name: string;
  description: string;
  amount_cents: number;
  status: WhiteGloveOfferStatus;
  created_by: string;
  created_at: string;
  paid_at: string | null;
  stripe_session_id: string | null;
};

/** Bounds mirrored from the table CHECK so the API fails fast with a clear message. */
export const WHITE_GLOVE_OFFER_MIN_CENTS = 100;
export const WHITE_GLOVE_OFFER_MAX_CENTS = 5_000_000;

export async function createWhiteGloveOffer(
  data: {
    businessId: string;
    name: string;
    description: string;
    amountCents: number;
    createdBy: string;
  },
  client?: SupabaseClient
): Promise<WhiteGloveOfferRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("white_glove_offers")
    .insert({
      business_id: data.businessId,
      name: data.name,
      description: data.description,
      amount_cents: data.amountCents,
      created_by: data.createdBy
    })
    .select("*")
    .single();
  if (error) throw new Error(`createWhiteGloveOffer: ${error.message}`);
  return row as WhiteGloveOfferRow;
}

/** All offers for a business, newest first (admin panel + billing page). */
export async function listWhiteGloveOffers(
  businessId: string,
  client?: SupabaseClient
): Promise<WhiteGloveOfferRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_offers")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listWhiteGloveOffers: ${error.message}`);
  return (data ?? []) as WhiteGloveOfferRow[];
}

/** Single offer by id, or null when it doesn't exist. */
export async function getWhiteGloveOffer(
  offerId: string,
  client?: SupabaseClient
): Promise<WhiteGloveOfferRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_offers")
    .select("*")
    .eq("id", offerId)
    .maybeSingle();
  if (error) throw new Error(`getWhiteGloveOffer: ${error.message}`);
  return (data as WhiteGloveOfferRow | null) ?? null;
}

/**
 * Revoke an OPEN offer (admin). Guarded on status so a concurrent payment
 * wins over the revoke: a paid offer stays paid. Returns whether a row
 * actually flipped.
 */
export async function revokeWhiteGloveOffer(
  offerId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_offers")
    .update({ status: "revoked" })
    .eq("id", offerId)
    .eq("status", "open")
    .select("id");
  if (error) throw new Error(`revokeWhiteGloveOffer: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Mark an offer paid (Stripe webhook, checkout.session.completed). Applies
 * regardless of current status: an admin revoke that raced the payment loses
 * (the customer DID pay — support can refund out-of-band, and 'paid' reflects
 * the money), and a webhook RETRY of an already-paid offer is an idempotent
 * re-write of the same values. Returns whether a row matched (false = offer
 * unknown, never an error).
 */
export async function markWhiteGloveOfferPaid(
  offerId: string,
  data: { paidAt: Date; stripeSessionId: string },
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: rows, error } = await db
    .from("white_glove_offers")
    .update({
      status: "paid",
      paid_at: data.paidAt.toISOString(),
      stripe_session_id: data.stripeSessionId
    })
    .eq("id", offerId)
    .select("id");
  if (error) throw new Error(`markWhiteGloveOfferPaid: ${error.message}`);
  return ((rows as unknown[] | null) ?? []).length > 0;
}

/**
 * Open the business's priority call/video support window after a custom-offer
 * payment. Unlike recordWhiteGlovePurchase (fixed packages), this must NOT
 * touch white_glove_package — that column is the fixed-package enum — and it
 * never SHORTENS an already-open window (a custom offer bought during an
 * existing window extends, not truncates).
 */
export async function extendPrioritySupport(
  businessId: string,
  until: Date,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error: readErr } = await db
    .from("businesses")
    .select("priority_support_until")
    .eq("id", businessId)
    .maybeSingle();
  if (readErr) throw new Error(`extendPrioritySupport read: ${readErr.message}`);
  const current = (row as { priority_support_until?: string | null } | null)
    ?.priority_support_until;
  if (current && new Date(current).getTime() >= until.getTime()) return;
  const { error } = await db
    .from("businesses")
    .update({ priority_support_until: until.toISOString() })
    .eq("id", businessId);
  if (error) throw new Error(`extendPrioritySupport: ${error.message}`);
}
