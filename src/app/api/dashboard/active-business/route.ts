/**
 * POST /api/dashboard/active-business — switch which business the dashboard
 * shows (agency/multi-business logins). Validates the target against the
 * caller's accessible set (owned + memberships) before setting the httpOnly
 * cookie, so the cookie can never point at a business the login has no role
 * on — and every later read re-validates anyway (resolveActiveBusinessContext).
 *
 * DELETE clears the cookie (falls back to the newest owned business).
 */
import { z } from "zod";
import { cookies } from "next/headers";
import { getAuthUser } from "@/lib/auth";
import {
  ACTIVE_BUSINESS_COOKIE,
  listAccessibleBusinesses
} from "@/lib/dashboard/active-business";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ businessId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = bodySchema.parse(await request.json());
    const accessible = await listAccessibleBusinesses(user);
    if (!accessible.some((b) => b.businessId === body.businessId)) {
      return errorResponse("FORBIDDEN", "You don't have access to that business", 403);
    }

    const store = await cookies();
    store.set(ACTIVE_BUSINESS_COOKIE, body.businessId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365
    });
    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}

export async function DELETE() {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const store = await cookies();
    store.delete(ACTIVE_BUSINESS_COOKIE);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
