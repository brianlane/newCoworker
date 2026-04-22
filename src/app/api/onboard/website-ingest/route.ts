import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAuthUser } from "@/lib/auth";
import { getOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { getBusiness, updateBusinessWebsiteUrl } from "@/lib/db/businesses";
import { setBusinessWebsiteMd } from "@/lib/db/configs";
import { ingestWebsite, normalizeWebsiteUrl } from "@/lib/website-ingest";
import { logger } from "@/lib/logger";

const schema = z.object({
  businessId: z.string().uuid(),
  websiteUrl: z.string().min(1),
  draftToken: z.string().uuid().optional(),
  businessName: z.string().optional(),
  businessType: z.string().optional()
});

async function isAuthorized(
  businessId: string,
  draftToken?: string
): Promise<{ ok: true; source: "draft" | "owner" } | { ok: false; reason: string }> {
  if (draftToken) {
    const draft = await getOnboardingDraft(businessId).catch(() => null);
    if (draft && draft.draft_token === draftToken) return { ok: true, source: "draft" };
  }

  const user = await getAuthUser();
  if (!user) return { ok: false, reason: "not authenticated" };
  if (user.isAdmin) return { ok: true, source: "owner" };
  if (!user.email) return { ok: false, reason: "no email" };

  const business = await getBusiness(businessId);
  if (!business || business.owner_email.toLowerCase() !== user.email.toLowerCase()) {
    return { ok: false, reason: "not owner" };
  }
  return { ok: true, source: "owner" };
}

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const normalized = normalizeWebsiteUrl(body.websiteUrl);
    if (!normalized) {
      return errorResponse("VALIDATION_ERROR", "Please provide a valid http(s) URL");
    }

    const auth = await isAuthorized(body.businessId, body.draftToken);
    if (!auth.ok) {
      return errorResponse("FORBIDDEN", auth.reason, 403);
    }

    const result = await ingestWebsite(normalized, {
      businessName: body.businessName,
      businessType: body.businessType
    });

    if (!result.ok) {
      logger.warn("website-ingest: failed", {
        businessId: body.businessId,
        websiteUrl: normalized,
        error: result.error,
        detail: result.detail
      });
      return successResponse({
        ok: false,
        error: result.error,
        detail: result.detail ?? null
      });
    }

    // Persist results. `setBusinessWebsiteMd` is race-safe against the parallel
    // `/api/business/config` upsert that runs from checkout — it inserts a
    // skeleton row with `ignoreDuplicates` (so it never clobbers existing
    // soul/identity/memory drafts) and then targets `website_md` alone.
    await updateBusinessWebsiteUrl(body.businessId, normalized).catch((err) => {
      logger.warn("website-ingest: persist website_url failed", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    });

    await setBusinessWebsiteMd(body.businessId, result.websiteMd);

    logger.info("website-ingest: success", {
      businessId: body.businessId,
      pagesCrawled: result.pagesCrawled,
      bytesDownloaded: result.bytesDownloaded
    });

    return successResponse({
      ok: true,
      pagesCrawled: result.pagesCrawled,
      bytesDownloaded: result.bytesDownloaded,
      websiteMdPreview: result.websiteMd.slice(0, 320),
      // Owners re-crawl from the dashboard and need the full summary to
      // overwrite the textarea in place. The onboarding caller (pre-auth)
      // ignores this field. Only returned when the caller proved ownership.
      websiteMd: auth.source === "owner" ? result.websiteMd : undefined
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
