import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateResidencyBackupDestination } from "@/lib/db/businesses";
import { setResidencyBackupCustody } from "@/lib/residency/backup-keys";
import { ResidencyValidationError } from "@/lib/residency/tier-gate";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z
  .object({
    businessId: z.string().uuid(),
    /** Where encrypted dumps go: central Storage vs on-box only. */
    destination: z.enum(["central", "onbox"]).optional(),
    /** Who holds the AES key: platform escrow vs the customer. */
    custody: z.enum(["escrowed", "customer_held"]).optional(),
    /**
     * `custody: 'customer_held'` DROPS the plaintext passphrase forever
     * (fingerprint only) — the platform can never again decrypt or restore
     * this tenant's dumps. Required acknowledgment for that flip.
     */
    acknowledgeIrreversible: z.boolean().optional().default(false)
  })
  .refine((b) => b.destination !== undefined || b.custody !== undefined, {
    message: "Provide destination and/or custody"
  });

/**
 * Admin levers for the residency-backup compliance knobs (Canadian and
 * insurance/legal deals): dump destination (`businesses.
 * residency_backup_destination`) and passphrase custody
 * (`residency_backup_keys.custody`). Enterprise-gated server-side in the
 * respective setters. Changes take effect on the tenant's next deploy
 * (backup.env is rewritten). See docs/COMPLIANCE-CANADA.md.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    if (body.custody === "customer_held" && !body.acknowledgeIrreversible) {
      return errorResponse(
        "VALIDATION_ERROR",
        "custody='customer_held' drops the plaintext passphrase forever (the platform can " +
          "never again decrypt or restore this tenant's dumps). Re-send with " +
          "acknowledgeIrreversible: true."
      );
    }

    if (body.destination) {
      await updateResidencyBackupDestination(body.businessId, body.destination);
    }
    if (body.custody) {
      await setResidencyBackupCustody(body.businessId, body.custody);
    }

    return successResponse({
      businessId: body.businessId,
      destination: body.destination ?? null,
      custody: body.custody ?? null,
      note: "Takes effect on the tenant's next deploy (backup.env rewritten)."
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof ResidencyValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
