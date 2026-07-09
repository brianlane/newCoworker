import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { can } from "@/lib/authz/policy";
import {
  applyComplianceModuleToSoul,
  parseComplianceModule
} from "@/lib/compliance/module";
import { updateBusinessWebsiteUrl } from "@/lib/db/businesses";
import { patchBusinessConfig } from "@/lib/db/configs";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
import { normalizeWebsiteUrl } from "@/lib/website-ingest";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { logger } from "@/lib/logger";
import {
  BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS,
  BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS,
  BUSINESS_CONFIG_SOUL_MD_MAX_CHARS,
  BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS
} from "@/lib/vault/business-config-markdown-limits";
import { z } from "zod";

// scheduleVaultSync runs the SSH vault re-seed in after(), which shares this
// invocation budget. syncVaultToVps alone permits a 60s SSH timeout plus
// Hostinger IP lookup + DB reads before SSH, so budget above 60s to keep a
// cold-VPS re-seed from being cut off.
export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  businessId: z.string().uuid(),
  ownerEmail: z.string().email().optional(),
  onboardingToken: z.string().min(1).optional(),
  signupUserId: z.string().uuid().optional(),
  soulMd: z
    .string()
    .min(1)
    .max(
      BUSINESS_CONFIG_SOUL_MD_MAX_CHARS,
      `Soul must be at most ${BUSINESS_CONFIG_SOUL_MD_MAX_CHARS.toLocaleString()} characters`
    ),
  identityMd: z
    .string()
    .min(1)
    .max(
      BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS,
      `Identity must be at most ${BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS.toLocaleString()} characters`
    ),
  memoryMd: z
    .string()
    .max(
      BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS,
      `Memory must be at most ${BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS.toLocaleString()} characters`
    )
    .optional(),
  /**
   * Optional manual override for the website.md vault file. The dashboard
   * lets owners edit or re-crawl it; onboarding leaves it undefined so the
   * value written by `/api/onboard/website-ingest` survives the config
   * save. When present (including empty string), we persist exactly what
   * the client sent.
   */
  websiteMd: z
    .string()
    .max(
      BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS,
      `Website knowledge must be at most ${BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS.toLocaleString()} characters`
    )
    .optional(),
  /**
   * Optional updated website URL. The dashboard lets owners edit the URL
   * input and click Save without re-crawling; previously this change was
   * silently discarded because only the Re-crawl path called
   * `updateBusinessWebsiteUrl`. An empty string clears the value so an
   * owner can remove a broken URL without re-crawling.
   */
  websiteUrl: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    const body = schema.parse(await request.json());
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    const db = await createSupabaseServiceClient();
    let ownerEmail: string | null = null;
    let isAdmin = false;

    if (user) {
      ownerEmail = user.email;
      isAdmin = user.isAdmin;
      if (!ownerEmail && !isAdmin) {
        return errorResponse("FORBIDDEN", "Account has no email address");
      }
    } else {
      if (body.ownerEmail && body.signupUserId) {
        const isValidSignupIdentity = await verifySignupIdentity(body.signupUserId, body.ownerEmail);
        if (!isValidSignupIdentity) {
          return errorResponse("FORBIDDEN", "Not authorized for this business");
        }
        ownerEmail = body.ownerEmail;
      } else if (body.onboardingToken && verifyOnboardingToken(body.onboardingToken, { businessId: body.businessId })) {
        const { data: business } = await db
          .from("businesses")
          .select("owner_email")
          .eq("id", body.businessId)
          .single();
        if (!business || business.owner_email !== createPendingOwnerEmail(body.businessId)) {
          return errorResponse("FORBIDDEN", "Onboarding token is no longer valid");
        }
        ownerEmail = null;
      } else {
        return errorResponse("FORBIDDEN", "Authentication required");
      }
    }

    if (ownerEmail && !isAdmin) {
      // Role-aware ownership check (Phase 2): editing the agent config is a
      // manage_settings action, so owners AND managers pass; staff and
      // strangers are refused. Replaces the legacy owner_email-only filter.
      const role = await getBusinessRoleForEmail(body.businessId, ownerEmail, db);
      if (!role || !can(role, "manage_settings")) {
        return errorResponse("FORBIDDEN", "Not authorized for this business");
      }
    } else {
      const { data } = await db
        .from("businesses")
        .select("id")
        .eq("id", body.businessId)
        .single();
      if (!data && !isAdmin) return errorResponse("FORBIDDEN", "Not authorized for this business");
    }

    // Persist `website_url` on the `businesses` row when the dashboard sends
    // one. The Re-crawl path has always written this column; without this
    // branch a plain Save would silently drop URL edits because the rest of
    // this route only touches `business_configs`. An empty string explicitly
    // clears the field (owner removing a stale URL); anything non-empty is
    // normalized through the same helper the ingest route uses so bad input
    // fails fast with a 422 instead of persisting a malformed URL.
    if (body.websiteUrl !== undefined) {
      const trimmed = body.websiteUrl.trim();
      if (trimmed.length === 0) {
        await updateBusinessWebsiteUrl(body.businessId, null);
      } else {
        const normalized = normalizeWebsiteUrl(trimmed);
        if (!normalized) {
          return errorResponse("VALIDATION_ERROR", "Please provide a valid http(s) URL");
        }
        try {
          await updateBusinessWebsiteUrl(body.businessId, normalized);
        } catch (err) {
          // Don't fail the entire save for a transient `businesses` update
          // error — the soul/identity/memory patch below is the higher-value
          // write. Log so we can catch repeated failures in telemetry.
          logger.warn("business-config: persist website_url failed", {
            businessId: body.businessId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    // `patchBusinessConfig` is race-safe against the parallel website-ingest
    // fire-and-forget. It never touches fields we don't explicitly patch, so
    // `website_md` (absent from onboarding's payload) is preserved whether the
    // crawl finished before or after this save. Dashboard callers that want to
    // clear it send `websiteMd: ""` explicitly.
    // Enterprise custom compliance module survives soul edits: the soul
    // editors round-trip the marker block, but a save that deleted (or
    // mangled) it must not silently strip the tenant's guardrails while
    // businesses.compliance_module stays set. Re-apply the canonical block
    // whenever a module exists — applyComplianceModuleToSoul strips any
    // existing block first, so a normal round-trip save is a no-op.
    let soulMd = body.soulMd;
    const { data: moduleRow } = await db
      .from("businesses")
      .select("tier, compliance_module")
      .eq("id", body.businessId)
      .maybeSingle();
    if (moduleRow?.tier === "enterprise") {
      const complianceModule = parseComplianceModule(moduleRow.compliance_module);
      if (complianceModule) {
        soulMd = applyComplianceModuleToSoul(soulMd, complianceModule);
      }
    }

    const patch: {
      soul_md: string;
      identity_md: string;
      memory_md?: string;
      website_md?: string;
    } = {
      soul_md: soulMd,
      identity_md: body.identityMd
    };
    if (body.memoryMd !== undefined) patch.memory_md = body.memoryMd;
    if (body.websiteMd !== undefined) patch.website_md = body.websiteMd;

    await patchBusinessConfig(body.businessId, patch);

    // Re-seed the live VPS vault + MongoDB agent prompt from the freshly
    // patched `business_configs`. Without this, owner edits in the dashboard
    // would land in Supabase but never reach the per-tenant Rowboat agent —
    // chat / SMS / voice would keep replying from the provision-time vault
    // snapshot. Deferred to after() so the SSH re-seed reliably completes on
    // Vercel without blocking the response (Supabase is the source of truth).
    scheduleVaultSync(body.businessId);

    return successResponse({ updated: true });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    return handleRouteError(err);
  }
}
