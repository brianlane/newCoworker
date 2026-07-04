/**
 * BYON wizard step 3: prefilled LOA download.
 *
 * POST /api/dashboard/byon/loa
 *   body: { businessId, phone, carrier { entityName, authorizedName,
 *           accountNumber }, serviceAddress, carrierName? }
 *   → application/pdf attachment prefilled with the wizard's fields; the
 *     owner signs it and uploads it back on the final step.
 *
 * Auth mirrors /api/dashboard/csv: getAuthUser + requireOwner (admins bypass).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { generateLoaPdf } from "@/lib/byon/loa-pdf";
import { ByonValidationError } from "@/lib/byon/port-requests";
import { assertByonAllowedForBusiness } from "@/lib/byon/tier-gate";
import { normalizeContactNumber } from "@/lib/telnyx/format";

export const dynamic = "force-dynamic";

const LOA_RATE = { interval: 60 * 1000, maxRequests: 10 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  phone: z.string().min(1, "Enter a phone number"),
  carrier: z.object({
    entityName: z.string().min(1, "Enter the business name on the account"),
    authorizedName: z.string().min(1, "Enter the authorized person's name"),
    accountNumber: z.string().min(1, "Enter the carrier account number")
  }),
  serviceAddress: z.object({
    street: z.string().min(1, "Enter the street address"),
    extended: z.string().optional(),
    city: z.string().min(1, "Enter the city"),
    state: z.string().min(1, "Enter the state"),
    zip: z.string().min(1, "Enter the ZIP code")
  }),
  carrierName: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const parsed = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(parsed.businessId);

    const limiter = rateLimit(`byon-loa:${parsed.businessId}`, LOA_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many downloads, slow down.", 429);
    }

    // BYON is Standard-only.
    await assertByonAllowedForBusiness(parsed.businessId);

    const normalized = normalizeContactNumber(parsed.phone);
    if (!normalized.ok || !normalized.value.startsWith("+")) {
      return errorResponse("VALIDATION_ERROR", "Enter the full phone number you want to port.");
    }

    const bytes = await generateLoaPdf({
      phoneE164: normalized.value,
      entityName: parsed.carrier.entityName,
      authorizedName: parsed.carrier.authorizedName,
      accountNumber: parsed.carrier.accountNumber,
      serviceAddress: parsed.serviceAddress,
      carrierName: parsed.carrierName
    });

    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="letter-of-authorization.pdf"'
      }
    });
  } catch (err) {
    if (err instanceof ByonValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
