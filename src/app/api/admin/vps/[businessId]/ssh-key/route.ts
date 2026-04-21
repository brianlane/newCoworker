/**
 * GET /api/admin/vps/:businessId/ssh-key
 *
 * Admin-only "break glass" endpoint that returns the active per-VPS private
 * key so an operator can SSH into a tenant VPS for debugging without going
 * through the orchestrator.
 *
 * Security:
 *   - `requireAdmin()` must return truthy — non-admin sessions get 403.
 *   - Payload includes the full PKCS#8 private key. Callers should treat
 *     it as sensitive: don't log, don't cache, rotate if exfiltrated.
 *   - The response is Cache-Control: no-store to keep CDNs from stashing it.
 *   - Audit logs (coworker_logs) receive a `ssh_key_disclosed` event with
 *     the admin's user id so retrievals are traceable.
 */

import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  getActiveVpsSshKey,
  getActiveVpsSshKeyForBusiness
} from "@/lib/db/vps-ssh-keys";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const paramsSchema = z.object({
  businessId: z.string().uuid()
});

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ businessId: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { businessId } = paramsSchema.parse(await ctx.params);

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    // Prefer a lookup keyed by hostinger_vps_id when we have one — it's
    // guaranteed one-per-row. Fall back to business_id for businesses that
    // were provisioned before we started storing the vpsId column.
    const row = business.hostinger_vps_id
      ? await getActiveVpsSshKey(business.hostinger_vps_id)
      : await getActiveVpsSshKeyForBusiness(businessId);

    if (!row) {
      return errorResponse(
        "NOT_FOUND",
        "No active SSH key on file for this business (provision has not run or keys were rotated)"
      );
    }

    logger.info("SSH key disclosed to admin", {
      businessId,
      vpsId: row.hostinger_vps_id,
      fingerprint: row.fingerprint_sha256,
      adminId: admin.userId,
      adminEmail: admin.email
    });

    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          businessId: row.business_id,
          hostingerVpsId: row.hostinger_vps_id,
          fingerprint: row.fingerprint_sha256,
          publicKey: row.public_key,
          privateKeyPem: row.private_key_pem,
          sshUsername: row.ssh_username,
          createdAt: row.created_at
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, private"
        }
      }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid path");
    }
    return handleRouteError(err);
  }
}

// Export so we can pin in tests / prevent accidental caching.
export const dynamic = "force-dynamic";
