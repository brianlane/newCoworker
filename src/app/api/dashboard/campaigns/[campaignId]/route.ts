/**
 * Email campaigns — single-campaign management.
 *
 *   PATCH  /api/dashboard/campaigns/:campaignId
 *            body: { businessId, subject?, bodyMd?, audienceTag?,
 *                    sendAt? | null, action?: "cancel" }
 *   DELETE /api/dashboard/campaigns/:campaignId?businessId=…
 *
 * Edits apply to draft/scheduled campaigns only (a sending/sent campaign is
 * history). Cancel is a guarded transition so it can never race the sweep's
 * promotion into clobbering a mid-send campaign; a campaign that already
 * started sending keeps sending (the batch that went out can't be recalled).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteEmailCampaign,
  getEmailCampaign,
  transitionEmailCampaign,
  type EmailCampaignPatch
} from "@/lib/campaigns/db";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  businessId: z.string().uuid(),
  subject: z.string().trim().min(1).max(300).optional(),
  bodyMd: z.string().trim().min(1).max(8000).optional(),
  audienceTag: z.string().trim().max(40).optional(),
  /** ISO datetime schedules; null moves a scheduled campaign back to draft. */
  sendAt: z.string().datetime({ offset: true }).nullable().optional(),
  action: z.literal("cancel").optional()
});

type RouteContext = { params: Promise<{ campaignId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { campaignId } = await context.params;
    if (!z.string().uuid().safeParse(campaignId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid campaign id");
    }
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const existing = await getEmailCampaign(body.data.businessId, campaignId);
    if (!existing) return errorResponse("NOT_FOUND", "Campaign not found", 404);

    if (body.data.action === "cancel") {
      // Guarded: only a still-scheduled (or draft) campaign can cancel.
      const cancelled =
        (await transitionEmailCampaign(body.data.businessId, campaignId, "scheduled", {
          status: "cancelled"
        })) ||
        (await transitionEmailCampaign(body.data.businessId, campaignId, "draft", {
          status: "cancelled"
        }));
      if (!cancelled) {
        return errorResponse(
          "VALIDATION_ERROR",
          "This campaign already started sending and can't be cancelled.",
          409
        );
      }
      const updated = await getEmailCampaign(body.data.businessId, campaignId);
      return successResponse({ campaign: updated });
    }

    if (existing.status !== "draft" && existing.status !== "scheduled") {
      return errorResponse(
        "VALIDATION_ERROR",
        "Only draft or scheduled campaigns can be edited."
      );
    }

    const patch: EmailCampaignPatch = {};
    if (body.data.subject !== undefined) patch.subject = body.data.subject;
    if (body.data.bodyMd !== undefined) patch.body_md = body.data.bodyMd;
    if (body.data.audienceTag !== undefined) patch.audience_tag = body.data.audienceTag;
    if (body.data.sendAt !== undefined) {
      if (body.data.sendAt === null) {
        patch.send_at = null;
        patch.status = "draft";
      } else {
        if (Date.parse(body.data.sendAt) < Date.now() - 60_000) {
          return errorResponse("VALIDATION_ERROR", "The send time is in the past");
        }
        patch.send_at = new Date(body.data.sendAt).toISOString();
        patch.status = "scheduled";
      }
    }
    if (Object.keys(patch).length === 0) {
      return errorResponse("VALIDATION_ERROR", "Nothing to update");
    }

    // Guarded on the status we validated against: if the sweep promoted
    // the campaign to `sending` between our read and this write, the edit
    // loses cleanly instead of yanking a mid-send campaign back to
    // draft/scheduled while its recipients keep draining.
    const applied = await transitionEmailCampaign(
      body.data.businessId,
      campaignId,
      existing.status,
      patch
    );
    if (!applied) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This campaign just started sending and can't be edited.",
        409
      );
    }
    const updated = await getEmailCampaign(body.data.businessId, campaignId);
    return successResponse({ campaign: updated });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { campaignId } = await context.params;
    if (!z.string().uuid().safeParse(campaignId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid campaign id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_settings");

    const existing = await getEmailCampaign(businessId.data, campaignId);
    if (!existing) return successResponse({ deleted: true }); // idempotent
    // The delete itself is status-guarded (`neq sending`), so a sweep
    // promotion racing this read can never cascade-drop a mid-send
    // campaign's recipient snapshot.
    const deleted = await deleteEmailCampaign(businessId.data, campaignId);
    if (!deleted) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This campaign is mid-send; deleting isn't possible and history is retained.",
        409
      );
    }
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
