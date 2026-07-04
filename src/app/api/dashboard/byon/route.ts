/**
 * BYON port requests.
 *
 * GET    /api/dashboard/byon?businessId=<uuid>
 *          → { requests: NumberPortRequestRow[] } (status card)
 * POST   /api/dashboard/byon?businessId=<uuid>
 *          body: { phone, carrier, serviceAddress, loa, bill, focDatetimeRequested? }
 *          → { rows, submitted, submitError } — creates the Telnyx porting
 *            order, uploads the LOA + bill, attaches details, confirms.
 * DELETE /api/dashboard/byon?businessId=<uuid>&id=<uuid>
 *          → { request } — cancels a not-yet-ported order.
 *
 * Auth mirrors /api/dashboard/csv: getAuthUser + requireOwner (admins bypass).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  ByonValidationError,
  cancelByonPortRequest,
  createByonPortRequest,
  listByonPortRequests
} from "@/lib/byon/port-requests";
import { assertByonAllowedForBusiness } from "@/lib/byon/tier-gate";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 30 };
// Port submissions upload documents to Telnyx — keep the ceiling low.
const CREATE_RATE = { interval: 60 * 60 * 1000, maxRequests: 10 };
const CANCEL_RATE = { interval: 60 * 1000, maxRequests: 10 };

const documentSchema = z.object({
  base64: z.string().min(1, "Upload the document first"),
  filename: z.string().min(1)
});

const createSchema = z.object({
  phone: z.string().min(1, "Enter a phone number"),
  carrier: z.object({
    entityName: z.string().min(1, "Enter the business name on the account"),
    authorizedName: z.string().min(1, "Enter the authorized person's name"),
    accountNumber: z.string().min(1, "Enter the carrier account number"),
    pin: z.string().optional(),
    billingPhone: z.string().optional()
  }),
  serviceAddress: z.object({
    street: z.string().min(1, "Enter the street address"),
    extended: z.string().optional(),
    city: z.string().min(1, "Enter the city"),
    state: z.string().min(1, "Enter the state"),
    zip: z.string().min(1, "Enter the ZIP code"),
    country: z.string().optional()
  }),
  loa: documentSchema,
  bill: documentSchema,
  focDatetimeRequested: z.string().datetime({ offset: true }).optional()
});

async function authorizedBusinessId(request: Request): Promise<string | NextResponseLike> {
  const user = await getAuthUser();
  if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
  const url = new URL(request.url);
  const businessId = z.string().uuid().parse(url.searchParams.get("businessId") ?? "");
  if (!user.isAdmin) await requireOwner(businessId);
  return businessId;
}

type NextResponseLike = ReturnType<typeof errorResponse>;

export async function GET(request: Request) {
  try {
    const businessId = await authorizedBusinessId(request);
    if (typeof businessId !== "string") return businessId;

    const limiter = rateLimit(`byon-list:${businessId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const requests = await listByonPortRequests(businessId);
    return successResponse({ requests });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const businessId = await authorizedBusinessId(request);
    if (typeof businessId !== "string") return businessId;

    const limiter = rateLimit(`byon-create:${businessId}`, CREATE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many port submissions, slow down.", 429);
    }

    // BYON is Standard-only: enforce before any Telnyx resources are created.
    await assertByonAllowedForBusiness(businessId);

    const parsed = createSchema.parse(await request.json());
    const result = await createByonPortRequest(businessId, parsed);
    return successResponse(result, 201);
  } catch (err) {
    if (err instanceof ByonValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const businessId = await authorizedBusinessId(request);
    if (typeof businessId !== "string") return businessId;

    const limiter = rateLimit(`byon-cancel:${businessId}`, CANCEL_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const url = new URL(request.url);
    const requestId = z.string().uuid().parse(url.searchParams.get("id") ?? "");
    const cancelled = await cancelByonPortRequest(businessId, requestId);
    if (!cancelled) return errorResponse("NOT_FOUND", "Port request not found");
    return successResponse({ request: cancelled });
  } catch (err) {
    if (err instanceof ByonValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
