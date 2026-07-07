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
  /** Null for PROSPECT offers authored before the account exists. */
  business_id: string | null;
  name: string;
  description: string;
  amount_cents: number;
  status: WhiteGloveOfferStatus;
  created_by: string;
  created_at: string;
  paid_at: string | null;
  stripe_session_id: string | null;
  /** Who the deal is for (required when business_id is null); pre-fills Checkout. */
  recipient_email: string | null;
  /** Unguessable capability behind the public /offer/<pay_token> payment link. */
  pay_token: string;
};

/** Bounds mirrored from the table CHECK so the API fails fast with a clear message. */
export const WHITE_GLOVE_OFFER_MIN_CENTS = 100;
export const WHITE_GLOVE_OFFER_MAX_CENTS = 5_000_000;

export async function createWhiteGloveOffer(
  data: {
    /** Null authors a PROSPECT offer (recipientEmail then required by the DB). */
    businessId: string | null;
    name: string;
    description: string;
    amountCents: number;
    createdBy: string;
    recipientEmail?: string | null;
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
      created_by: data.createdBy,
      recipient_email: data.recipientEmail ?? null
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

/** Prospect (pre-account) offers — business_id is null. Newest first. */
export async function listProspectWhiteGloveOffers(
  client?: SupabaseClient
): Promise<WhiteGloveOfferRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_offers")
    .select("*")
    .is("business_id", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listProspectWhiteGloveOffers: ${error.message}`);
  return (data ?? []) as WhiteGloveOfferRow[];
}

/**
 * Attach the owner's PROSPECT offers to their freshly created business —
 * called from createBusiness so a deal paid before signup follows the account
 * automatically. Matching is by recipient_email (case-insensitive). For every
 * PAID offer attached, the standard 30-day priority call/video support window
 * opens FROM NOW (attach time) — more generous than "from payment", and
 * monotonic via extendPrioritySupport. Billing then sees the paid offer via
 * listWhiteGloveOffers and hides the package upsell.
 *
 * Returns the number of offers attached. Callers treat failures as
 * best-effort (a ledger hiccup must never fail account creation).
 */
export async function attachProspectWhiteGloveOffersToBusiness(
  businessId: string,
  ownerEmail: string,
  client?: SupabaseClient
): Promise<number> {
  const email = ownerEmail.trim();
  if (!email) return 0;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_offers")
    .update({ business_id: businessId })
    .is("business_id", null)
    .ilike("recipient_email", email)
    .select("id, status");
  if (error) throw new Error(`attachProspectWhiteGloveOffersToBusiness: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; status: string }>;
  if (rows.some((r) => r.status === "paid")) {
    await extendPrioritySupport(businessId, prioritySupportWindowFromNow(), db);
  }
  return rows.length;
}

/** Attach-time priority window end: now + the standard 30 days. */
function prioritySupportWindowFromNow(): Date {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

/**
 * Inverse attach for the Stripe webhook: a PROSPECT offer was just PAID, and
 * the payer may already have an account (signed up between receiving the link
 * and paying it). Finds the newest business owned by any of the candidate
 * emails (offer recipient first, then the Stripe payer), stamps it onto the
 * offer (only while business_id is still null — never re-homes an attached
 * offer), and returns the business id so the caller can open the priority
 * window. Null when no account exists yet — createBusiness's attach picks the
 * offer up at signup instead.
 */
export async function attachPaidProspectOfferToBusinessByEmail(
  offerId: string,
  candidateEmails: Array<string | null | undefined>,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const emails = candidateEmails
    .map((e) => e?.trim() ?? "")
    .filter((e) => e.length > 0);
  for (const email of emails) {
    const { data, error } = await db
      .from("businesses")
      .select("id")
      .ilike("owner_email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`attachPaidProspectOfferToBusinessByEmail: ${error.message}`);
    const businessId = (data as { id?: string } | null)?.id;
    if (!businessId) continue;
    const { error: upErr } = await db
      .from("white_glove_offers")
      .update({ business_id: businessId })
      .eq("id", offerId)
      .is("business_id", null);
    if (upErr) {
      throw new Error(`attachPaidProspectOfferToBusinessByEmail: ${upErr.message}`);
    }
    return businessId;
  }
  return null;
}

/** The emailable public payment link for an offer (durable; never expires). */
export function whiteGloveOfferPayUrl(offer: Pick<WhiteGloveOfferRow, "pay_token">): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${appUrl}/offer/${offer.pay_token}`;
}

/** Resolve the offer behind a public payment link, or null. */
export async function getWhiteGloveOfferByPayToken(
  payToken: string,
  client?: SupabaseClient
): Promise<WhiteGloveOfferRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_offers")
    .select("*")
    .eq("pay_token", payToken)
    .maybeSingle();
  if (error) throw new Error(`getWhiteGloveOfferByPayToken: ${error.message}`);
  return (data as WhiteGloveOfferRow | null) ?? null;
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
 * Mark an offer paid (Stripe webhook, checkout.session.completed) — an ATOMIC
 * CLAIM, not a blind write. The update only matches when the offer is not yet
 * paid OR is already paid by THIS same Stripe session (webhook retry →
 * idempotent re-write of identical values). A completion from a DIFFERENT
 * session on an already-paid offer matches nothing and returns
 * "duplicate_session": the customer was charged twice (e.g. two Buy tabs both
 * reached Stripe before the first completion) and the caller must alert for a
 * refund instead of re-crediting. An admin revoke that raced the payment
 * still flips to 'paid' — the money is real; support refunds out-of-band.
 */
export async function markWhiteGloveOfferPaid(
  offerId: string,
  data: { paidAt: Date; stripeSessionId: string },
  client?: SupabaseClient
): Promise<"paid" | "duplicate_session"> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: rows, error } = await db
    .from("white_glove_offers")
    .update({
      status: "paid",
      paid_at: data.paidAt.toISOString(),
      stripe_session_id: data.stripeSessionId
    })
    .eq("id", offerId)
    .or(`status.neq.paid,stripe_session_id.eq.${data.stripeSessionId}`)
    .select("id");
  if (error) throw new Error(`markWhiteGloveOfferPaid: ${error.message}`);
  return ((rows as unknown[] | null) ?? []).length > 0 ? "paid" : "duplicate_session";
}

/**
 * Open the business's priority call/video support window after a custom-offer
 * payment. Unlike recordWhiteGlovePurchase (fixed packages), this must NOT
 * touch white_glove_package — that column is the fixed-package enum — and it
 * never SHORTENS an already-open window (a custom offer bought during an
 * existing window extends, not truncates). Monotonic-under-concurrency: the
 * guard lives in the UPDATE's WHERE clause (single statement), so two webhook
 * handlers finishing together can never overwrite a longer window with a
 * shorter one the way a read-compare-write would.
 */
export async function extendPrioritySupport(
  businessId: string,
  until: Date,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const untilIso = until.toISOString();
  const { error } = await db
    .from("businesses")
    .update({ priority_support_until: untilIso })
    .eq("id", businessId)
    .or(`priority_support_until.is.null,priority_support_until.lt.${untilIso}`);
  if (error) throw new Error(`extendPrioritySupport: ${error.message}`);
}
