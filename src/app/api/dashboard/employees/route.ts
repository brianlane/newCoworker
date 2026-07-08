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
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_settings"); admins bypass the ownership
 * check (existing dashboard convention).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  createTeamMember,
  listEmployeeRoutingStats,
  listTeamMembers,
  listTimeOff
} from "@/lib/db/employees";
import { parseScheduleText } from "@/lib/employees/schedule-text";
import { sharedCalendarStatus } from "@/lib/calendar-tools/shared-calendar";
import { normalizeDialableNumber } from "@/lib/telnyx/format";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({
  businessId: z.string().uuid()
});

// Forgiving phone input: "602-555-1234" and "(602) 555-1234" are assumed US
// (+1); explicit +country-code numbers pass through. Short codes are refused
// — roster numbers must be dialable. The parsed value is canonical E.164.
const phoneField = z.string().transform((val, ctx) => {
  const result = normalizeDialableNumber(val);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.reason });
    return z.NEVER;
  }
  return result.value;
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phoneE164: phoneField,
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

    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`employees-list:${businessId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const [members, timeOff, stats, sharedCalendar] = await Promise.all([
      listTeamMembers(businessId),
      listTimeOff(businessId),
      listEmployeeRoutingStats(businessId),
      sharedCalendarStatus(businessId)
    ]);

    return successResponse({ members, timeOff, stats, sharedCalendar });
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

    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

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
