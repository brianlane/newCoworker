/**
 * Employees roster endpoint.
 *
 * GET  /api/dashboard/employees?businessId=<uuid>
 *        → { members, timeOff, stats }   (roster + time off + routing stats)
 *
 * POST /api/dashboard/employees?businessId=<uuid>
 *        body: { name, phoneE164, email?, scheduleText?, preferredText? }
 *        → { member }
 *
 * The roster is the same ai_flow_team_members table route_to_team rotates
 * through, so adding someone here immediately puts them in the lead
 * rotation. Schedules arrive as the compact text form ("mon-fri
 * 09:00-17:00") and are parsed server-side so the stored jsonb is always
 * canonical.
 *
 * Auth: getAuthUser + requireOwner(businessId); admins bypass the ownership
 * check (existing dashboard convention).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  createTeamMember,
  listEmployeeRoutingStats,
  listTeamMembers,
  listTimeOff
} from "@/lib/db/employees";
import { parseScheduleText } from "@/lib/employees/schedule-text";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({
  businessId: z.string().uuid()
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +16025551234"),
  email: z.string().trim().email().max(254).nullable().optional(),
  scheduleText: z.string().max(500).optional(),
  preferredText: z.string().max(500).optional()
});

/** Parse a schedule text field, mapping parse failures to a 400. */
function parsedWindowsOrThrow(text: string | undefined, label: string): unknown {
  if (text === undefined) return null;
  const parsed = parseScheduleText(text);
  if (!parsed.ok) {
    throw Object.assign(new Error(`${label}: ${parsed.error}`), { status: 400 });
  }
  return parsed.value;
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`employees-list:${businessId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const [members, timeOff, stats] = await Promise.all([
      listTeamMembers(businessId),
      listTimeOff(businessId),
      listEmployeeRoutingStats(businessId)
    ]);

    return successResponse({ members, timeOff, stats });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

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

    let weeklySchedule: unknown;
    let preferredWindows: unknown;
    try {
      weeklySchedule = parsedWindowsOrThrow(body.scheduleText, "Weekly schedule");
      preferredWindows = parsedWindowsOrThrow(body.preferredText, "Preferred times");
    } catch (e) {
      return errorResponse("VALIDATION_ERROR", e instanceof Error ? e.message : "Invalid schedule", 400);
    }

    const member = await createTeamMember(businessId, {
      name: body.name,
      phoneE164: body.phoneE164,
      email: body.email ?? null,
      weeklySchedule,
      preferredWindows
    });

    return successResponse({ member });
  } catch (err) {
    return handleRouteError(err);
  }
}
