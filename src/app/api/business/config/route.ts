import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { patchBusinessConfig } from "@/lib/db/configs";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
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
  websiteMd: z.string().optional()
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
