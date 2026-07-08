/**
 * Saved SMS templates (Standard/Enterprise perk).
 *
 * GET  /api/dashboard/messages/templates?businessId=…   → { templates: [...] }
 * POST /api/dashboard/messages/templates                → { template } (created)
 *   body: { businessId: uuid, name: string, body: string }
 *
 * Templates are reusable verbatim bodies for the dashboard composer (no
 * variable substitution — owners expect what they saved to be what sends).
 * Tier-gated server-side; the composer hides the picker for Starter tenants
 * but the gate here is what actually enforces it.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"). Admins may target any
 * business (dashboard-chat / messages-send convention).
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

const createSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(1, "Template name can't be empty").max(80),
  body: z.string().trim().min(1, "Template body can't be empty").max(1600)
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId must be a UUID");
    }
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    const { data, error } = await db
      .from("sms_templates")
      .select("id, name, body, created_at, updated_at")
      .eq("business_id", businessId)
      .order("name", { ascending: true });
    if (error) return errorResponse("DB_ERROR", error.message);

    return successResponse({ templates: data ?? [] });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId, name, body } = createSchema.parse(json);

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    if (!(await smsToolsAllowedForBusiness(businessId, db))) {
      return errorResponse("FORBIDDEN", SMS_TOOLS_UPGRADE_MESSAGE);
    }

    const { data, error } = await db
      .from("sms_templates")
      .insert({ business_id: businessId, name, body })
      .select("id, name, body, created_at, updated_at")
      .single();
    if (error) {
      // Unique (business, lower(name)) → friendly conflict instead of a 500.
      if (error.code === "23505") {
        return errorResponse("CONFLICT", "A template with that name already exists.");
      }
      return errorResponse("DB_ERROR", error.message);
    }

    return successResponse({ template: data }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
