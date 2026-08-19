/**
 * Owner surface for the subscribable calendar feed.
 *
 *   GET  ?businessId=…  → the feed URL (minted on first ask)
 *   POST {businessId}   → rotate the token, revoking every shared copy
 *
 * Auth mirrors the integration routes: owner/manager session with
 * `manage_settings` (admins bypass). Works for EVERY tenant, which is the
 * point, Vagaro and Acuity businesses are exactly the ones the shared
 * NewCoworker calendar cannot always reach.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  ensureCalendarFeedToken,
  rotateCalendarFeedToken
} from "@/lib/db/calendar-feed";

const businessIdSchema = z.string().uuid();

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

/** The subscription URL. `.ics` suffix because some calendar apps require it. */
function feedUrl(request: Request, token: string): string {
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(request.url).origin;
  return `${origin.replace(/\/+$/, "")}/api/calendar/${token}.ics`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await authorize(parsed.data);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const token = await ensureCalendarFeedToken(parsed.data);
    return successResponse({ feedUrl: feedUrl(request, token) });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = z.object({ businessId: z.string().uuid() }).parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const token = await rotateCalendarFeedToken(body.businessId);
    return successResponse({ feedUrl: feedUrl(request, token), rotated: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
