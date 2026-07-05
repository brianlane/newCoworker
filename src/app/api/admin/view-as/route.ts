/**
 * Admin "view as" session control.
 *
 * POST   { businessId } → set the impersonation cookie (admin only)
 * DELETE                → clear it
 *
 * The cookie is httpOnly and only ever HONORED for the admin user
 * (src/lib/admin/view-as.ts re-checks isAdmin on every read), so setting it
 * is the only privileged step. The proxy also lets the admin through the
 * "/dashboard redirects admins to /admin" gate when the cookie is present.
 */

import { cookies } from "next/headers";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { VIEW_AS_COOKIE } from "@/lib/admin/view-as";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

const schema = z.object({
  businessId: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const store = await cookies();
    store.set(VIEW_AS_COOKIE, business.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      // Persistent cookie with a hard 4h cap (NOT session-scoped — a
      // persistent maxAge survives browser close, which is fine: the cookie
      // is only ever honored for the admin, view-as is read-only for
      // account/billing mutations, and it expires on its own). Exit via the
      // banner clears it immediately.
      maxAge: 4 * 60 * 60
    });

    return successResponse({
      businessId: business.id,
      name: business.name,
      tier: business.tier
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    const store = await cookies();
    store.delete(VIEW_AS_COOKIE);
    return successResponse({ cleared: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
