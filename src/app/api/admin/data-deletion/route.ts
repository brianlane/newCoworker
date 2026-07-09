import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { insertCoworkerLog } from "@/lib/db/logs";
import { deleteEndUserData, EndUserDeletionError } from "@/lib/privacy/deletion";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z
  .object({
    businessId: z.string().uuid(),
    /** E.164 of the person to erase. */
    e164: z.string().optional(),
    /** Email of the person to erase. */
    email: z.string().optional(),
    /** Deletion is unrecoverable — explicit acknowledgment required. */
    confirm: z.literal(true)
  })
  .refine((b) => Boolean(b.e164?.trim()) || Boolean(b.email?.trim()), {
    message: "Provide e164 and/or email"
  });

// Residency tenants add box round-trips per table.
export const maxDuration = 120;

/**
 * Admin end-user erasure (security review G6): deletes one person's rows
 * across the tenant's content tables — central AND the tenant box for
 * dual/vps residency tenants. Runs on a verified privacy request (PIPEDA /
 * Law 25 / CCPA erasure). The audit row stores a sha256 FINGERPRINT of the
 * identifier, never the identifier itself.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const result = await deleteEndUserData(body.businessId, {
      e164: body.e164,
      email: body.email
    });

    try {
      await insertCoworkerLog({
        id: crypto.randomUUID(),
        business_id: body.businessId,
        task_type: "data_flow",
        status: "success",
        log_payload: {
          action: "end_user_data_deleted",
          identifierFingerprint: result.identifierFingerprint,
          tables: result.tables
        }
      });
    } catch (err) {
      // The deletion itself succeeded; a failed audit insert must not make
      // the admin re-run it. Loud log instead.
      logger.error("data-deletion: audit log insert failed", {
        businessId: body.businessId,
        identifierFingerprint: result.identifierFingerprint,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({
      businessId: body.businessId,
      identifierFingerprint: result.identifierFingerprint,
      tables: result.tables
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof EndUserDeletionError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
