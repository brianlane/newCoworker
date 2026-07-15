/**
 * Apply a COMPLETED white-glove intake to a tenant (admin-only).
 *
 * POST /api/admin/white-glove-intakes/<id>/apply { businessId } writes the
 * intake's answers into the tenant's configuration (vault marker blocks,
 * parsed business hours, and the follow-up flow — installed disabled on
 * first apply) via `applyWhiteGloveIntake`, then schedules the vault → VPS
 * re-seed so the tenant's live agent picks the new grounding up.
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import {
  applyWhiteGloveIntake,
  WhiteGloveApplyError
} from "@/lib/white-glove/apply-service";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

export const runtime = "nodejs";

const bodySchema = z.object({ businessId: z.string().uuid() });

const idSchema = z.string().uuid();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const { id } = await params;
    const intakeId = idSchema.parse(id);
    const body = bodySchema.parse(await request.json());

    try {
      const result = await applyWhiteGloveIntake({
        intakeId,
        businessId: body.businessId
      });

      // Post-response re-seed: the vault write landed in Supabase; this
      // pushes it to the tenant box so the live agent stops answering from
      // the pre-apply prompt.
      scheduleVaultSync(body.businessId);

      return successResponse(result);
    } catch (err) {
      if (err instanceof WhiteGloveApplyError) {
        // Every typed apply error is thrown BEFORE the first tenant write
        // (guards + the vault-cap check), so there is nothing to re-seed.
        const status =
          err.code === "intake_not_found" || err.code === "business_not_found"
            ? "NOT_FOUND"
            : "CONFLICT";
        return errorResponse(status, err.message);
      }
      // An untyped failure can land MID-apply — the vault write may already
      // be committed centrally. Re-seed anyway (idempotent) so the tenant
      // box never keeps serving pre-apply grounding behind a 500.
      scheduleVaultSync(body.businessId);
      throw err;
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
