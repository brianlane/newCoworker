import { requireAuth } from "@/lib/auth";
import { upsertBusinessConfig } from "@/lib/db/configs";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  soulMd: z.string().min(1),
  identityMd: z.string().min(1),
  memoryMd: z.string()
});

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = schema.parse(await request.json());

    // Verify ownership
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    const db = await createSupabaseServiceClient();
    const { data } = await db
      .from("businesses")
      .select("id")
      .eq("id", body.businessId)
      .eq("owner_email", user.email)
      .single();

    if (!data && !user.isAdmin) {
      return errorResponse("FORBIDDEN", "Not authorized for this business");
    }

    await upsertBusinessConfig({
      business_id: body.businessId,
      soul_md: body.soulMd,
      identity_md: body.identityMd,
      memory_md: body.memoryMd
    });

    return successResponse({ updated: true });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.errors[0].message);
    return handleRouteError(err);
  }
}
