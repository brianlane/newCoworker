/**
 * Admin CRUD for custom white-glove offers.
 *
 * POST   — create a bespoke offer (name + custom amount) for one business,
 *          OR for a PROSPECT (recipientEmail instead of businessId — payable
 *          via the public /offer/<pay_token> link before any account exists).
 *          The stored row is the pricing source of truth for Stripe Checkout;
 *          the client never supplies an amount at pay time. The offer is
 *          EMAILED to its recipient (explicit recipientEmail, else the
 *          business owner) with the payment link — best-effort: an email
 *          hiccup never fails the creation, and the response reports
 *          `emailedTo` (or null) so the admin knows whether to send the link
 *          manually. The payUrl is always returned.
 * GET    — list offers: ?businessId=<uuid> for a business's panel, or
 *          ?prospect=1 for pre-account offers.
 * DELETE — revoke an OPEN offer (a paid offer can't be revoked; refunds are
 *          handled through the existing force-refund tooling).
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  createWhiteGloveOffer,
  listWhiteGloveOffers,
  listProspectWhiteGloveOffers,
  revokeWhiteGloveOffer,
  whiteGloveOfferPayUrl,
  WHITE_GLOVE_OFFER_MIN_CENTS,
  WHITE_GLOVE_OFFER_MAX_CENTS,
  type WhiteGloveOfferRow
} from "@/lib/db/white-glove-offers";
import { buildWhiteGloveOfferEmail } from "@/lib/email/templates/white-glove-offer";
import { sendOwnerEmail } from "@/lib/email/client";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

/**
 * Email the freshly created offer to its recipient with the payment link.
 * Best-effort: returns the address it emailed, or null (no recipient / no
 * RESEND key / send failure) so the caller can tell the admin to copy the
 * link manually instead.
 */
async function emailOfferToRecipient(
  offer: WhiteGloveOfferRow,
  recipientEmail: string | null,
  payUrl: string
): Promise<string | null> {
  if (!recipientEmail) return null;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("white_glove_offer create: RESEND_API_KEY unset; offer not emailed", {
      offerId: offer.id
    });
    return null;
  }
  try {
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const { subject, text, html } = buildWhiteGloveOfferEmail({
      offerName: offer.name,
      description: offer.description,
      amountCents: offer.amount_cents,
      payUrl,
      recipientEmail,
      siteUrl
    });
    await sendOwnerEmail(apiKey, recipientEmail, subject, { text, html });
    return recipientEmail;
  } catch (err) {
    logger.error("white_glove_offer create: offer email failed (non-fatal)", {
      offerId: offer.id,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

const createSchema = z
  .object({
    businessId: z.string().uuid().optional(),
    recipientEmail: z.string().trim().email().max(320).optional(),
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(500).optional(),
    // Whole-dollar UI convenience; converted to cents server-side.
    amountUsd: z
      .number()
      .min(WHITE_GLOVE_OFFER_MIN_CENTS / 100)
      .max(WHITE_GLOVE_OFFER_MAX_CENTS / 100)
  })
  .refine((b) => b.businessId || b.recipientEmail, {
    message: "Provide a businessId or a recipientEmail"
  });

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = createSchema.parse(await request.json());

    let ownerEmail: string | null = null;
    if (body.businessId) {
      const business = await getBusiness(body.businessId);
      if (!business) return errorResponse("NOT_FOUND", "Business not found");
      ownerEmail = business.owner_email ?? null;
    }

    const offer = await createWhiteGloveOffer({
      businessId: body.businessId ?? null,
      name: body.name,
      description: body.description ?? "",
      amountCents: Math.round(body.amountUsd * 100),
      createdBy: admin.email ?? admin.userId,
      recipientEmail: body.recipientEmail ?? null
    });
    const payUrl = whiteGloveOfferPayUrl(offer);
    // Explicit recipient first (the admin typed it); a business-tied offer
    // without one goes to the owner so "Create offer" always notifies someone.
    const emailedTo = await emailOfferToRecipient(
      offer,
      body.recipientEmail ?? ownerEmail,
      payUrl
    );
    return successResponse({ offer, payUrl, emailedTo });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    if (url.searchParams.get("prospect") === "1") {
      const offers = await listProspectWhiteGloveOffers();
      return successResponse({
        offers: offers.map((o) => ({ ...o, payUrl: whiteGloveOfferPayUrl(o) }))
      });
    }
    const businessId = url.searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId must be a UUID");
    }
    const offers = await listWhiteGloveOffers(businessId);
    return successResponse({
      offers: offers.map((o) => ({ ...o, payUrl: whiteGloveOfferPayUrl(o) }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

const revokeSchema = z.object({ offerId: z.string().uuid() });

export async function DELETE(request: Request) {
  try {
    await requireAdmin();
    const body = revokeSchema.parse(await request.json());
    const revoked = await revokeWhiteGloveOffer(body.offerId);
    if (!revoked) {
      return errorResponse("CONFLICT", "Offer is not open (already paid or revoked)");
    }
    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
