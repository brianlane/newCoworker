/**
 * Single SMS template management (Standard/Enterprise perk).
 *
 * PATCH  /api/dashboard/messages/templates/:id  body { businessId, name?, body? }
 * DELETE /api/dashboard/messages/templates/:id  body { businessId }
 *
 * businessId rides in the body (PATCH/DELETE) so requireBusinessRole can gate before
 * any row is touched; the row update itself is additionally scoped by
 * business_id so a template id from another tenant can never be affected.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  SMS_TOOLS_UPGRADE_MESSAGE,
  smsToolsAllowedForBusiness
} from "@/lib/plans/sms-tools";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    businessId: z.string().uuid(),
    name: z.string().trim().min(1).max(80).optional(),
    body: z.string().trim().min(1).max(1600).optional()
  })
  .refine((v) => v.name !== undefined || v.body !== undefined, {
    message: "Provide name and/or body to update"
  });

const deleteSchema = z.object({ businessId: z.string().uuid() });

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) {
      return errorResponse("VALIDATION_ERROR", "Template id must be a UUID");
    }

    const json = (await request.json().catch(() => null)) as unknown;
    const parsed = patchSchema.parse(json);

    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    if (!(await smsToolsAllowedForBusiness(parsed.businessId, db))) {
      return errorResponse("FORBIDDEN", SMS_TOOLS_UPGRADE_MESSAGE);
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.name !== undefined) updates.name = parsed.name;
    if (parsed.body !== undefined) updates.body = parsed.body;

    const { data, error } = await db
      .from("sms_templates")
      .update(updates)
      .eq("id", id)
      .eq("business_id", parsed.businessId)
      .select("id, name, body, created_at, updated_at")
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return errorResponse("CONFLICT", "A template with that name already exists.");
      }
      return errorResponse("DB_ERROR", error.message);
    }
    if (!data) return errorResponse("NOT_FOUND", "Template not found");

    return successResponse({ template: data });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) {
      return errorResponse("VALIDATION_ERROR", "Template id must be a UUID");
    }

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId } = deleteSchema.parse(json);

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    if (!(await smsToolsAllowedForBusiness(businessId, db))) {
      return errorResponse("FORBIDDEN", SMS_TOOLS_UPGRADE_MESSAGE);
    }

    const { data, error } = await db
      .from("sms_templates")
      .delete()
      .eq("id", id)
      .eq("business_id", businessId)
      .select("id")
      .maybeSingle();
    if (error) return errorResponse("DB_ERROR", error.message);
    if (!data) return errorResponse("NOT_FOUND", "Template not found");

    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
