/**
 * Per-user sidebar layout (order + visibility). Scoped to the SIGNED-IN
 * auth user — no business role involved, and safe during view-as (an
 * impersonating admin edits their own layout, never the tenant's).
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getSidebarLayout, saveSidebarLayout } from "@/lib/dashboard/sidebar-prefs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const items = await getSidebarLayout(user.userId);
    return successResponse({ items });
  } catch (err) {
    return handleRouteError(err);
  }
}

const postSchema = z.object({
  items: z
    .array(z.object({ key: z.string().min(1).max(64), visible: z.boolean() }))
    .min(1)
    .max(64)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = postSchema.parse(await request.json());
    try {
      await saveSidebarLayout(user.userId, body.items);
    } catch (err) {
      // Unknown/duplicate keys are caller errors, not 500s.
      if (err instanceof Error && /unknown item key|duplicate item key/.test(err.message)) {
        return errorResponse("VALIDATION_ERROR", err.message);
      }
      throw err;
    }
    const items = await getSidebarLayout(user.userId);
    return successResponse({ items });
  } catch (err) {
    return handleRouteError(err);
  }
}
