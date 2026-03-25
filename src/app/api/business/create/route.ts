import { requireAuth } from "@/lib/auth";
import { createBusiness } from "@/lib/db/businesses";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1),
  tier: z.enum(["starter", "standard", "enterprise"]),
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
    const user = await requireAuth();
    const body = schema.parse(await request.json());

    const business = await createBusiness({
      id: body.businessId,
      name: body.name,
      ownerEmail: user.email ?? "",
      tier: body.tier,
      businessType: body.businessType,
      ownerName: body.ownerName,
      phone: body.phone,
      serviceArea: body.serviceArea,
      typicalInquiry: body.typicalInquiry,
      teamSize: body.teamSize ? parseInt(body.teamSize, 10) : undefined,
      crmUsed: body.crmUsed
    });

    return successResponse({ businessId: business.id });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    return handleRouteError(err);
  }
}
