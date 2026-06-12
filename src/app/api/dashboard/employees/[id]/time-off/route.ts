/**
 * Employee time-off endpoint.
 *
 * POST   /api/dashboard/employees/:id/time-off?businessId=<uuid>
 *          body: { startsOn: "YYYY-MM-DD", endsOn: "YYYY-MM-DD", note? }
 *          → { timeOff }
 *
 * DELETE /api/dashboard/employees/:id/time-off?businessId=<uuid>&timeOffId=<uuid>
 *          → { ok: true }
 *
 * Dates are whole days in the business timezone (route_to_team hard-skips a
 * member whose range covers the business-local "today" — supersedes pinned
 * routing).
 *
 * Auth: getAuthUser + requireOwner(businessId); admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { addTimeOff, deleteTimeOff } from "@/lib/db/employees";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const paramsSchema = z.object({ id: z.string().uuid() });

const querySchema = z.object({ businessId: z.string().uuid() });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z
  .object({
    startsOn: z.string().regex(ISO_DATE, "Use YYYY-MM-DD"),
    endsOn: z.string().regex(ISO_DATE, "Use YYYY-MM-DD"),
    note: z.string().trim().max(300).nullable().optional()
  })
  .refine((b) => b.endsOn >= b.startsOn, {
    message: "Time off must end on or after the day it starts"
  });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = paramsSchema.parse(await ctx.params);
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`employees-write:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = createSchema.parse(await request.json());

    const timeOff = await addTimeOff(businessId, {
      memberId: id,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      note: body.note ?? null
    });

    return successResponse({ timeOff });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // The member id is implied by the time-off row; parse it anyway so a
    // malformed URL fails loudly instead of deleting by query param alone.
    paramsSchema.parse(await ctx.params);
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    const timeOffId = z.string().uuid().parse(url.searchParams.get("timeOffId") ?? "");

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`employees-write:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    await deleteTimeOff(businessId, timeOffId);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
