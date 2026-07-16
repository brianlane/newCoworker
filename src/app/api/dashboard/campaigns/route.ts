/**
 * Email campaigns — dashboard management API.
 *
 *   GET  /api/dashboard/campaigns?businessId=…   → list campaigns
 *   POST /api/dashboard/campaigns                → create (draft or scheduled)
 *
 * A campaign is subject + markdown body + an audience (a contact tag, or
 * everyone with an email), sent by the per-minute sweep once its send time
 * passes. Everything customer-facing stays owner-reviewed: nothing sends
 * without an explicit schedule.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { insertEmailCampaign, listEmailCampaigns } from "@/lib/campaigns/db";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const createSchema = z.object({
  businessId: z.string().uuid(),
  subject: z.string().trim().min(1).max(300),
  bodyMd: z.string().trim().min(1).max(8000),
  audienceTag: z.string().trim().max(40).optional(),
  /** ISO datetime; present = scheduled, absent = draft. */
  sendAt: z.string().datetime({ offset: true }).optional()
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

    const campaigns = await listEmailCampaigns(businessId.data);
    return successResponse({ campaigns });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const body = createSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const limiter = rateLimit(`campaigns-write:${body.data.businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    if (body.data.sendAt && Date.parse(body.data.sendAt) < Date.now() - 60_000) {
      return errorResponse("VALIDATION_ERROR", "The send time is in the past");
    }

    const campaign = await insertEmailCampaign({
      business_id: body.data.businessId,
      subject: body.data.subject,
      body_md: body.data.bodyMd,
      audience_tag: body.data.audienceTag ?? "",
      ...(body.data.sendAt
        ? { status: "scheduled" as const, send_at: new Date(body.data.sendAt).toISOString() }
        : {})
    });
    return successResponse({ campaign });
  } catch (err) {
    return handleRouteError(err);
  }
}
