import { requireAdmin } from "@/lib/auth";
import { createBusiness } from "@/lib/db/businesses";
import { createSubscription } from "@/lib/db/subscriptions";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  name: z.string().min(1),
  ownerEmail: z.string().email(),
  tier: z.enum(["starter", "standard", "enterprise"]),
  businessType: z.string().optional(),
  ownerName: z.string().optional(),
  phone: z.string().optional(),
  /**
   * Optional hardware pin, offered in the admin modal for enterprise deals
   * (custom pricing means the operator sizes the box per contract). Omitted
   * = tier default at provision time (enterprise → kvm8).
   */
  vpsSize: z.enum(["kvm1", "kvm2", "kvm4", "kvm8"]).optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = schema.parse(await request.json());
    const businessId = crypto.randomUUID();

    const business = await createBusiness({
      id: businessId,
      name: body.name,
      ownerEmail: body.ownerEmail,
      tier: body.tier,
      businessType: body.businessType,
      ownerName: body.ownerName,
      phone: body.phone,
      vpsSize: body.vpsSize ?? null
    });

    await createSubscription({
      id: crypto.randomUUID(),
      business_id: businessId,
      tier: body.tier,
      status: "active",
      stripe_customer_id: null,
      stripe_subscription_id: null
    });

    return successResponse({ businessId: business.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
