import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { createBusiness } from "@/lib/db/businesses";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { createOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
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

    const business = await createBusiness({
      id: body.businessId,
      name: body.name,
      ownerEmail,
      tier: body.tier,
      businessType: body.businessType,
      ownerName: body.ownerName,
      phone: body.phone,
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
