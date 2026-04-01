import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { upsertBusinessConfig } from "@/lib/db/configs";
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
  memoryMd: z.string().optional()
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

    const { getBusinessConfig } = await import("@/lib/db/configs");
    const existing = await getBusinessConfig(body.businessId);

    await upsertBusinessConfig({
      business_id: body.businessId,
      soul_md: body.soulMd,
      identity_md: body.identityMd,
      memory_md: body.memoryMd ?? existing?.memory_md ?? ""
    });

    return successResponse({ updated: true });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    return handleRouteError(err);
  }
}
