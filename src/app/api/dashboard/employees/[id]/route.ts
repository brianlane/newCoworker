/**
 * Per-employee endpoint.
 *
 * PATCH  /api/dashboard/employees/:id?businessId=<uuid>
 *          body: { name?, phoneE164?, email?, active?, scheduleText?, preferredText? }
 *          → { member }
 *
 * DELETE /api/dashboard/employees/:id?businessId=<uuid>
 *          → { ok: true }
 *
 * Deactivating (active=false) keeps history; deleting removes the row and
 * cascades the employee's time-off entries. Either way the member drops out
 * of route_to_team immediately.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_settings"); admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { deleteTeamMember, updateTeamMember, type TeamMemberPatch } from "@/lib/db/employees";
import { parseScheduleText } from "@/lib/employees/schedule-text";
import { normalizeDialableNumber } from "@/lib/telnyx/format";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const paramsSchema = z.object({ id: z.string().uuid() });

const querySchema = z.object({ businessId: z.string().uuid() });

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Forgiving phone input: bare US numbers are assumed +1, short codes are
    // refused (roster numbers must be dialable). Parses to canonical E.164.
    phoneE164: z
      .string()
      .transform((val, ctx) => {
        const result = normalizeDialableNumber(val);
        if (!result.ok) {
          ctx.addIssue({ code: "custom", message: result.reason });
          return z.NEVER;
        }
        return result.value;
      })
      .optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    active: z.boolean().optional(),
    scheduleText: z.string().max(500).optional(),
    preferredText: z.string().max(500).optional()
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "Provide at least one field to update"
  });

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = paramsSchema.parse(await ctx.params);
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`employees-write:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = patchSchema.parse(await request.json());

    const patch: TeamMemberPatch = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phoneE164 !== undefined ? { phoneE164: body.phoneE164 } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.active !== undefined ? { active: body.active } : {})
    };
    if (body.scheduleText !== undefined) {
      const parsed = parseScheduleText(body.scheduleText);
      if (!parsed.ok) {
        return errorResponse("VALIDATION_ERROR", `Weekly schedule: ${parsed.error}`);
      }
      patch.weeklySchedule = parsed.value;
    }
    if (body.preferredText !== undefined) {
      const parsed = parseScheduleText(body.preferredText);
      if (!parsed.ok) {
        return errorResponse("VALIDATION_ERROR", `Preferred times: ${parsed.error}`);
      }
      patch.preferredWindows = parsed.value;
    }

    const member = await updateTeamMember(businessId, id, patch);
    if (!member) return errorResponse("NOT_FOUND", "Employee not found");

    return successResponse({ member });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = paramsSchema.parse(await ctx.params);
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`employees-write:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    // Idempotent delete: removing an already-removed member is a no-op, not
    // a 404 — flaky-network retries shouldn't error.
    await deleteTeamMember(businessId, id);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
