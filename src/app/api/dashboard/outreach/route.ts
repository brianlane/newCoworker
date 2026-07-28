/**
 * Prospecting — owner dashboard API.
 *
 *   GET /api/dashboard/outreach?businessId=…  → settings, funnel, review queue
 *   PUT /api/dashboard/outreach               → save settings (incl. the mode)
 *
 * The mode is the owner's switch: `off` stops the sweep picking the business up
 * at all, `manual` drafts and waits, `auto` sends inside the window and cap.
 * Refusing an unworkable configuration (no postal address, no offer, an
 * inverted window) happens in src/lib/outreach/owner.ts so the message is
 * readable rather than a constraint violation.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  loadProspectingView,
  MAX_CITIES,
  MAX_SEARCH_TERMS,
  ProspectingSettingsError,
  saveProspectingSettings
} from "@/lib/outreach/owner";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const saveSchema = z.object({
  businessId: z.string().uuid(),
  mode: z.enum(["off", "manual", "auto"]),
  searchTerms: z.array(z.string().trim().max(80)).max(MAX_SEARCH_TERMS),
  cities: z.array(z.string().trim().max(80)).max(MAX_CITIES),
  dailyCap: z.number().int().min(0).max(200),
  sendWindowStartHour: z.number().int().min(0).max(23),
  sendWindowEndHour: z.number().int().min(1).max(24),
  postalAddress: z.string().max(300),
  valueProp: z.string().max(600),
  senderName: z.string().max(120)
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_settings");

    return successResponse(await loadProspectingView(businessId.data));
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const body = saveSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const limiter = rateLimit(`outreach-settings:${body.data.businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const settings = await saveProspectingSettings(body.data.businessId, body.data);
    return successResponse({ settings });
  } catch (err) {
    if (err instanceof ProspectingSettingsError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
