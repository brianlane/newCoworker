/**
 * Admin CRUD for custom white-glove offers.
 *
 * POST   — create a bespoke offer (name + custom amount) for one business.
 *          The stored row is the pricing source of truth for the owner's
 *          Stripe Checkout; the client never supplies an amount at pay time.
 * GET    — list a business's offers (?businessId=) for the admin panel.
 * DELETE — revoke an OPEN offer (a paid offer can't be revoked; refunds are
 *          handled through the existing force-refund tooling).
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  createWhiteGloveOffer,
  listWhiteGloveOffers,
  revokeWhiteGloveOffer,
  WHITE_GLOVE_OFFER_MIN_CENTS,
  WHITE_GLOVE_OFFER_MAX_CENTS
} from "@/lib/db/white-glove-offers";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

const createSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional(),
  // Whole-dollar UI convenience; converted to cents server-side.
  amountUsd: z
    .number()
    .min(WHITE_GLOVE_OFFER_MIN_CENTS / 100)
    .max(WHITE_GLOVE_OFFER_MAX_CENTS / 100)
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = createSchema.parse(await request.json());

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const offer = await createWhiteGloveOffer({
      businessId: body.businessId,
      name: body.name,
      description: body.description ?? "",
      amountCents: Math.round(body.amountUsd * 100),
      createdBy: admin.email ?? admin.userId
    });
    return successResponse({ offer });
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
    const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId must be a UUID");
    }
    const offers = await listWhiteGloveOffers(businessId);
    return successResponse({ offers });
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
