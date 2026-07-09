/**
 * Admin-only custom compliance module (enterprise): per-tenant guardrail
 * text + restricted-term list layered on top of the platform guardrails.
 *
 * POST { businessId, complianceModule | null }
 *
 * Delivery to the LIVE agent: after persisting the module we rewrite the
 * marker-delimited block inside business_configs.soul_md and schedule a
 * vault sync — the same path dashboard soul edits take — so the change
 * reaches the tenant box without a redeploy. Not-yet-provisioned tenants
 * skip the soul rewrite; the provisioner bakes the module in at deploy.
 */
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateComplianceModule } from "@/lib/db/businesses";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import {
  complianceModuleSchema,
  applyComplianceModuleToSoul,
  parseComplianceModule
} from "@/lib/compliance/module";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { BUSINESS_CONFIG_SOUL_MD_MAX_CHARS } from "@/lib/vault/business-config-markdown-limits";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** `null` clears the module (platform guardrails only). */
  complianceModule: complianceModuleSchema.nullable()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    // Setting a module is enterprise-only; clearing is allowed on any tier
    // so a downgraded tenant can always shed a stale module.
    const normalized = parseComplianceModule(body.complianceModule);
    if (normalized && business.tier !== "enterprise") {
      return errorResponse(
        "VALIDATION_ERROR",
        "Custom compliance modules apply only to enterprise tier businesses"
      );
    }

    // Ordering: rewrite the LIVE prompt (soul_md) BEFORE persisting the
    // jsonb column. A soul-patch failure then fails the whole request with
    // the column untouched (no silent drift where the column claims a
    // module the live prompt doesn't have); if the column write fails after
    // the soul patch, the live prompt is already correct and the admin's
    // retry converges the column. Skipped when the tenant has no config yet
    // (pre-provision) — the orchestrator bakes the module in at deploy.
    const config = await getBusinessConfig(body.businessId);
    if (config) {
      const nextSoul = applyComplianceModuleToSoul(config.soul_md ?? "", normalized);
      // Mirror /api/business/config's cap: the block must not push the
      // stored soul past the limit the soul editor enforces.
      if (nextSoul.length > BUSINESS_CONFIG_SOUL_MD_MAX_CHARS) {
        return errorResponse(
          "VALIDATION_ERROR",
          `The tenant's soul plus this module exceeds ${BUSINESS_CONFIG_SOUL_MD_MAX_CHARS.toLocaleString()} characters — shorten the module (or the soul)`
        );
      }
      await patchBusinessConfig(body.businessId, { soul_md: nextSoul });
    }
    await updateComplianceModule(body.businessId, normalized);
    if (config) {
      scheduleVaultSync(body.businessId);
    }

    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
