import { requireAuth } from "@/lib/auth";
import { upsertBusinessConfig } from "@/lib/db/configs";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  soulMd: z.string().min(1),
  identityMd: z.string().min(1),
  memoryMd: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = schema.parse(await request.json());

    if (!user.email && !user.isAdmin) {
      return errorResponse("FORBIDDEN", "Account has no email address");
    }

    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    const db = await createSupabaseServiceClient();
    const { data } = user.email
      ? await db
          .from("businesses")
          .select("id")
          .eq("id", body.businessId)
          .eq("owner_email", user.email)
          .single()
      : { data: null };

    if (!data && !user.isAdmin) {
      return errorResponse("FORBIDDEN", "Not authorized for this business");
    }

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
