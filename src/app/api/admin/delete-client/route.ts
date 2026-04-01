import { requireAdmin } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid()
});

export async function DELETE(request: Request) {
  try {
    await requireAdmin();

    const body = schema.parse(await request.json());
    const db = await createSupabaseServiceClient();

    const { error } = await db
      .from("businesses")
      .delete()
      .eq("id", body.businessId);

    if (error) return errorResponse("DB_ERROR", error.message);

    return successResponse({ deleted: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
