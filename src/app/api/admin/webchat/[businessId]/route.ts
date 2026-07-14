/**
 * Admin control for a tenant's website chat widget REPLY ENGINE
 * (Admin → business → Web chat card).
 *
 * GET  → widget summary (enabled, engine, key presence).
 * POST → { replyEngine: "vps" | "gemini" } — flips who answers widget
 *        turns. 'gemini' routes turns to the platform-side direct
 *        responder (src/lib/webchat/gemini-engine.ts), which is how a
 *        tenant with no live VPS (e.g. the internal marketing-site pilot
 *        after its box returned to the adopt pool) keeps a working chat.
 *        Applies on the visitor's next turn — no redeploy, no box contact.
 *
 * Deliberately admin-only: the owner-facing widget settings surface never
 * exposes the engine (it's an infrastructure decision, not a preference).
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import {
  getOrCreateWidgetSettings,
  getWidgetSettingsForBusiness,
  updateWidgetSettings,
  webchatReplyEngine
} from "@/lib/webchat/db";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ businessId: z.string().uuid() });
const bodySchema = z.object({ replyEngine: z.enum(["vps", "gemini"]) });

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ businessId: string }> }
) {
  try {
    await requireAdmin();
    const { businessId } = paramsSchema.parse(await ctx.params);
    const settings = await getWidgetSettingsForBusiness(businessId);
    return successResponse({
      configured: !!settings,
      enabled: settings?.enabled ?? false,
      replyEngine: settings ? webchatReplyEngine(settings) : "vps",
      hasKey: !!settings?.public_key
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ businessId: string }> }
) {
  try {
    await requireAdmin();
    const { businessId } = paramsSchema.parse(await ctx.params);
    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const body = bodySchema.parse(await request.json());
    // First flip on a tenant whose owner never opened the widget settings
    // mints the (disabled) row — the engine choice must not depend on the
    // owner having visited their settings page first.
    await getOrCreateWidgetSettings(businessId);
    const updated = await updateWidgetSettings(businessId, {
      reply_engine: body.replyEngine
    });

    return successResponse({
      configured: true,
      enabled: updated.enabled,
      replyEngine: webchatReplyEngine(updated),
      hasKey: !!updated.public_key
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
