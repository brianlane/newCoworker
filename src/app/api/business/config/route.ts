import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { updateBusinessWebsiteUrl } from "@/lib/db/businesses";
import { patchBusinessConfig } from "@/lib/db/configs";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
import { normalizeWebsiteUrl } from "@/lib/website-ingest";
import { logger } from "@/lib/logger";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  ownerEmail: z.string().email().optional(),
  onboardingToken: z.string().min(1).optional(),
  signupUserId: z.string().uuid().optional(),
  soulMd: z.string().min(1),
  identityMd: z.string().min(1),
  memoryMd: z.string().optional(),
  /**
   * Optional manual override for the website.md vault file. The dashboard
   * lets owners edit or re-crawl it; onboarding leaves it undefined so the
   * value written by `/api/onboard/website-ingest` survives the config
   * save. When present (including empty string), we persist exactly what
   * the client sent.
   */
  websiteMd: z.string().optional(),
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

    const { data } = ownerEmail
      ? await db
          .from("businesses")
          .select("id")
          .eq("id", body.businessId)
          .eq("owner_email", ownerEmail)
          .single()
      : await db
          .from("businesses")
          .select("id")
          .eq("id", body.businessId)
          .single();

    if (!data && !isAdmin) return errorResponse("FORBIDDEN", "Not authorized for this business");

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
    const patch: {
      soul_md: string;
      identity_md: string;
      memory_md?: string;
      website_md?: string;
    } = {
      soul_md: body.soulMd,
      identity_md: body.identityMd
    };
    if (body.memoryMd !== undefined) patch.memory_md = body.memoryMd;
    if (body.websiteMd !== undefined) patch.website_md = body.websiteMd;

    await patchBusinessConfig(body.businessId, patch);

    return successResponse({ updated: true });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    return handleRouteError(err);
  }
}
