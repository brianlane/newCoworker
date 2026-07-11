/**
 * Owner-facing management for the business's DIRECT CalDAV connection
 * (iCloud app-specific password / Nextcloud / generic CalDAV — the
 * zero-OAuth calendar path, mirroring /api/integrations/calendly).
 *
 *   GET    ?businessId=…   → connection state (masked; no secret material)
 *   POST   {businessId, serverUrl?, username?, password?}
 *            → create/update credentials, then VERIFY end-to-end (full
 *              CalDAV discovery walk) and persist the picked event calendar
 *              so tool calls skip discovery.
 *   PATCH  {businessId, isActive}  → soft-disable / re-enable.
 *   DELETE {businessId}    → remove the connection entirely.
 *
 * Auth mirrors the other integration routes: owner/manager session with
 * `manage_settings` on the business (admins bypass).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  CaldavConnectionValidationError,
  deleteCaldavConnection,
  getCaldavConnection,
  getPublicCaldavConnection,
  upsertCaldavConnection
} from "@/lib/db/caldav-connections";
import { pickPreferredCalendar, verifyCaldavConnection } from "@/lib/caldav/client";

const businessIdSchema = z.string().uuid();

const upsertSchema = z.object({
  businessId: z.string().uuid(),
  // All optional on update (keep the stored values); required on first
  // connect (enforced by the db layer).
  serverUrl: z.string().min(1).max(2048).optional(),
  username: z.string().min(1).max(512).optional(),
  password: z.string().min(1).max(1024).optional()
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  isActive: z.boolean()
});

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await authorize(parsed.data);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const row = await getPublicCaldavConnection(parsed.data);
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = upsertSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    await upsertCaldavConnection(body);

    // Verify the stored credentials end-to-end (full discovery walk). On
    // success, persist the picked event calendar so tool calls run one
    // REPORT instead of the 3-step discovery; failure CLEARS the cached
    // calendar — the card must never claim a calendar the credentials no
    // longer reach.
    const conn = await getCaldavConnection(body.businessId);
    const verification = conn
      ? await verifyCaldavConnection({
          serverUrl: conn.server_url,
          username: conn.username,
          password: conn.password
        })
      : ({ ok: false, reason: "request_failed" } as const);
    const picked = verification.ok ? pickPreferredCalendar(verification.calendars) : null;
    await upsertCaldavConnection({
      businessId: body.businessId,
      calendarUrl: picked?.url ?? null,
      calendarName: picked?.name ?? null
    });
    const row = await getPublicCaldavConnection(body.businessId);
    return successResponse({
      connection: row,
      verified: verification.ok,
      ...(verification.ok ? {} : { verifyError: verification.reason })
    });
  } catch (err) {
    if (err instanceof CaldavConnectionValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const existing = await getPublicCaldavConnection(body.businessId);
    if (!existing) return errorResponse("NOT_FOUND", "No CalDAV connection");
    const row = await upsertCaldavConnection({
      businessId: body.businessId,
      isActive: body.isActive
    });
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = z
      .object({ businessId: z.string().uuid() })
      .parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    await deleteCaldavConnection(body.businessId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
