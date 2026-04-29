import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { createBusiness, getBusiness } from "@/lib/db/businesses";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { createOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
import { logger } from "@/lib/logger";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1),
  tier: z.enum(["starter", "standard", "enterprise"]),
  ownerEmail: z.string().email().optional(),
  signupUserId: z.string().uuid().optional(),
  businessType: z.string().optional(),
  ownerName: z.string().optional(),
  phone: z.string().optional(),
  websiteUrl: z.string().optional(),
  serviceArea: z.string().optional(),
  typicalInquiry: z.string().optional(),
  teamSize: z.string().optional(),
  crmUsed: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    const body = schema.parse(await request.json());
    let ownerEmail: string;
    let onboardingToken: string | null = null;

    if (user?.email) {
      ownerEmail = user.email;
    } else {
      if (body.ownerEmail && body.signupUserId) {
        const isValidSignupIdentity = await verifySignupIdentity(body.signupUserId, body.ownerEmail);
        if (!isValidSignupIdentity) {
          return errorResponse("FORBIDDEN", "Not authorized to create business");
        }
        ownerEmail = body.ownerEmail;
      } else if (body.signupUserId) {
        return errorResponse("FORBIDDEN", "Authentication required");
      } else {
        ownerEmail = createPendingOwnerEmail(body.businessId);
        onboardingToken = createOnboardingToken({ businessId: body.businessId });
      }
    }

    // Idempotent re-create. The questionnaire client persists `businessId`
    // in localStorage, so any failure path between a successful INSERT
    // here and the subsequent `persistedToDatabase: true` write on the
    // client (e.g. tab close, network drop, intermediate route 5xx,
    // pre-deploy versions of the orchestrator that didn't set the flag)
    // strands the UUID in localStorage. The user retries "Proceed to
    // Payment", we hit the row, the INSERT fails with a unique-PK
    // violation (Postgres 23505), and `handleRouteError` collapses it
    // into a generic 500 the user can't recover from.
    //
    // Resolution: if a row already exists for this businessId, mirror
    // the contract of a fresh create when its `owner_email` is the same
    // value we'd otherwise assign on a fresh insert (the pending sentinel
    // for the anon Stripe-first flow, the user/legacy email for auth
    // paths). Mint a fresh `onboardingToken` for the anonymous case so
    // the client can continue. Different owner_email means another party
    // owns this UUID — refuse with 409 rather than silently overwrite.
    const existing = await getBusiness(body.businessId);
    if (existing) {
      if (existing.owner_email === ownerEmail) {
        logger.info("business.create idempotent: returning existing row", {
          businessId: body.businessId,
          anonymous: !user
        });
        return successResponse({ businessId: existing.id, onboardingToken });
      }
      logger.warn("business.create blocked: businessId already bound to a different owner", {
        businessId: body.businessId
      });
      return errorResponse(
        "CONFLICT",
        "This business id is already in use. Please refresh and try again.",
        409
      );
    }

    const business = await createBusiness({
      id: body.businessId,
      name: body.name,
      ownerEmail,
      tier: body.tier,
      businessType: body.businessType,
      ownerName: body.ownerName,
      phone: body.phone,
      websiteUrl: body.websiteUrl,
      serviceArea: body.serviceArea,
      typicalInquiry: body.typicalInquiry,
      teamSize: body.teamSize ? parseInt(body.teamSize, 10) : undefined,
      crmUsed: body.crmUsed
    });

    return successResponse({ businessId: business.id, onboardingToken });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    return handleRouteError(err);
  }
}
