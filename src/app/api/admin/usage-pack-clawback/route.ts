/**
 * POST /api/admin/usage-pack-clawback
 *
 * Operator-initiated void of a usage-pack grant. Customer Stripe refunds
 * without New Coworker metadata, and disputes, do not claw back packs;
 * this route is the intentional manual path when support refunds a pack.
 *
 * Body:
 *   sourceId: grant key (`cs_...` for Billing top-ups, or
 *             `inv_{id}:{voice|sms|chat}:{packId}` for membership packs)
 *   kind: "voice" | "sms" | "chat"
 *   clawbackAmount?: number | null  (omit/null = full void)
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { clawbackUsagePackGrantBySourceId } from "@/lib/billing/usage-pack-clawback";
import { logAdminAction } from "@/lib/admin/audit";

const schema = z.object({
  sourceId: z.string().trim().min(1).max(200),
  kind: z.enum(["voice", "sms", "chat"]),
  clawbackAmount: z.number().int().positive().nullable().optional(),
  businessId: z.string().uuid().optional()
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await request.json());

    const result = await clawbackUsagePackGrantBySourceId({
      sourceId: body.sourceId,
      kind: body.kind,
      reason: "admin",
      clawbackAmount: body.clawbackAmount === undefined ? null : body.clawbackAmount
    });

    if (!result.ok) {
      return errorResponse("INTERNAL_SERVER_ERROR", result.error, 500);
    }
    // The RPCs report a miss in-band (jsonb ok:false), not as a PostgREST
    // error, so without this check a typo'd sourceId or a voice id sent
    // with kind:"sms" read as a completed clawback (HTTP 200). Operators
    // and scripts gate on status; a miss must be loud.
    const rpcOutcome = result.result as { ok?: boolean; reason?: string } | null;
    if (rpcOutcome && rpcOutcome.ok === false) {
      return errorResponse(
        "NOT_FOUND",
        `No ${body.kind} grant matches sourceId ${body.sourceId} (${rpcOutcome.reason ?? "unknown reason"}). Nothing was clawed back.`,
        404
      );
    }

    await logAdminAction({
      adminEmail: admin.email ?? null,
      action: "usage_pack_clawback",
      businessId: body.businessId ?? null,
      detail: {
        sourceId: body.sourceId,
        kind: body.kind,
        clawbackAmount: body.clawbackAmount ?? null,
        result: result.result
      }
    });

    return successResponse({ ok: true, result: result.result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body", 422);
    }
    return handleRouteError(err);
  }
}
