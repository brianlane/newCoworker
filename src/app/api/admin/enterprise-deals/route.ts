/**
 * Admin CRUD for enterprise deals (custom setup + monthly pricing).
 *
 * POST   — create a deal (setup + monthly, in whole USD from the admin UI)
 *          for ONE enterprise-tier business. The stored row is the pricing
 *          source of truth for Stripe Checkout; the payer never supplies an
 *          amount. Returns the durable public payment link
 *          (/enterprise-offer/<pay_token>) for the admin to send.
 * GET    — list a business's deals (?businessId=<uuid>).
 * DELETE — revoke an OPEN deal (an active deal can't be revoked here; the
 *          underlying Stripe subscription is canceled through the normal
 *          billing lifecycle instead).
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  createEnterpriseDeal,
  listEnterpriseDeals,
  revokeEnterpriseDeal,
  enterpriseDealPayUrl,
  ENTERPRISE_DEAL_MONTHLY_MIN_CENTS,
  ENTERPRISE_DEAL_MAX_CENTS
} from "@/lib/db/enterprise-deals";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

const createSchema = z.object({
  businessId: z.string().uuid(),
  // Whole-dollar UI convenience; converted to cents server-side.
  setupUsd: z
    .number()
    .min(0)
    .max(ENTERPRISE_DEAL_MAX_CENTS / 100),
  monthlyUsd: z
    .number()
    .min(ENTERPRISE_DEAL_MONTHLY_MIN_CENTS / 100)
    .max(ENTERPRISE_DEAL_MAX_CENTS / 100)
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = createSchema.parse(await request.json());

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    if (business.tier !== "enterprise") {
      return errorResponse("VALIDATION_ERROR", "Enterprise deals apply only to enterprise tier businesses");
    }

    let deal;
    try {
      deal = await createEnterpriseDeal({
        businessId: body.businessId,
        setupCents: Math.round(body.setupUsd * 100),
        monthlyCents: Math.round(body.monthlyUsd * 100),
        createdBy: admin.email ?? admin.userId
      });
    } catch (err) {
      // The partial unique index allows one open/active deal per business;
      // surface that as a clear conflict instead of a 500.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("enterprise_deals_one_live_per_business_idx")) {
        return errorResponse(
          "CONFLICT",
          "This business already has an open or active deal — revoke it before creating a new one"
        );
      }
      throw err;
    }

    return successResponse({ deal, payUrl: enterpriseDealPayUrl(deal) });
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
    const businessId = url.searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId must be a UUID");
    }
    const deals = await listEnterpriseDeals(businessId);
    return successResponse({
      deals: deals.map((d) => ({ ...d, payUrl: enterpriseDealPayUrl(d) }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

const revokeSchema = z.object({ dealId: z.string().uuid() });

export async function DELETE(request: Request) {
  try {
    await requireAdmin();
    const body = revokeSchema.parse(await request.json());
    const revoked = await revokeEnterpriseDeal(body.dealId);
    if (!revoked) {
      return errorResponse("CONFLICT", "Deal is not open (already active, revoked, or canceled)");
    }
    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
