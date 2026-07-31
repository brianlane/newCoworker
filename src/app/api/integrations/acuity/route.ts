/**
 * Owner-facing management for the business's Acuity Scheduling connection.
 *
 *   GET    ?businessId=…            → connection state (masked; no key material)
 *          ?businessId=…&catalog=1  → plus the appointment types and calendars
 *                                     the card's default pickers render
 *   POST   {businessId, userId, apiKey?}
 *            → create/update credentials, then VERIFY them against GET /me
 *              and hand back the catalog so the card can render immediately.
 *   PATCH  {businessId, defaultAppointmentTypeId?, defaultCalendarId?,
 *           suppressProviderEmails?, isActive?}
 *            → booking defaults / soft-disable.
 *   DELETE {businessId}             → remove the connection entirely.
 *
 * Auth mirrors the other integration routes: owner/manager session with
 * `manage_settings` on the business (admins bypass). This surface manages the
 * credential vault; the agent never calls it.
 *
 * One Acuity-specific behavior worth knowing: the card also reports whether
 * ANOTHER dedicated booking provider is already connected. Vagaro wins
 * calendar resolution over Acuity by design (it is the incumbent, and a
 * silent provider switch would move live bookings to a different book), so a
 * merchant who connects Acuity while Vagaro is live would otherwise get a
 * connection that silently does nothing.
 */
import { z } from "zod";
import { logger } from "@/lib/logger";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  AcuityConnectionValidationError,
  deleteAcuityConnection,
  getAcuityConnection,
  getPublicAcuityConnection,
  setAcuityBookingDefaults,
  upsertAcuityConnection
} from "@/lib/db/acuity-connections";
import { getActiveVagaroConnectionId } from "@/lib/db/vagaro-connections";
import {
  acuityWebhookCallbackUrl,
  ensureAcuityWebhooks,
  teardownAcuityWebhooks
} from "@/lib/acuity/webhook-registration";
import {
  AcuityApiError,
  clearAcuityCaches,
  listAcuityAppointmentTypes,
  listAcuityCalendars,
  verifyAcuityCredentials
} from "@/lib/acuity/client";

const businessIdSchema = z.string().uuid();

/** The public origin to build the tenant's callback URL from. */
function appOrigin(request: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(request.url).origin;
}

const upsertSchema = z.object({
  businessId: z.string().uuid(),
  userId: z.string().min(1).max(64),
  /**
   * Optional on update (keep the stored key); required on first connect
   * (enforced by the db layer). Length-bounded like custom integrations.
   */
  apiKey: z.string().min(1).max(4096).optional()
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  defaultAppointmentTypeId: z.string().max(120).nullable().optional(),
  defaultCalendarId: z.string().max(120).nullable().optional(),
  suppressProviderEmails: z.boolean().optional(),
  isActive: z.boolean().optional()
});

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

/**
 * The appointment types + calendars the card's pickers need, plus the
 * calendar timezone we cache on the connection.
 *
 * Errors are REPORTED, never thrown: a catalog read failing must not make a
 * saved connection look unsaved.
 */
async function readCatalog(businessId: string) {
  const conn = await getAcuityConnection(businessId);
  if (!conn) {
    return { appointmentTypes: [], calendars: [], catalogError: "request_failed" as const };
  }
  try {
    const appointmentTypes = await listAcuityAppointmentTypes(conn);
    const calendars = await listAcuityCalendars(conn);
    return { appointmentTypes, calendars, catalogError: null };
  } catch (err) {
    const code = err instanceof AcuityApiError ? err.code : "request_failed";
    return { appointmentTypes: [], calendars: [], catalogError: code };
  }
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

    const row = await getPublicAcuityConnection(parsed.data);
    // Vagaro beats Acuity in calendar resolution, so say so rather than
    // letting the owner connect something that will never be consulted.
    const vagaroId = await getActiveVagaroConnectionId(parsed.data);
    const otherBookingProviderActive = vagaroId ? "vagaro" : null;

    if (url.searchParams.get("catalog") === "1" && row) {
      const catalog = await readCatalog(parsed.data);
      return successResponse({ connection: row, otherBookingProviderActive, ...catalog });
    }
    return successResponse({ connection: row, otherBookingProviderActive });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = upsertSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const row = await upsertAcuityConnection(body);
    // A credential rotation must not serve a catalog cached under the old
    // key, and the cache is keyed by connection row id.
    clearAcuityCaches();

    // Verify end-to-end and hand back the catalog. A failed verification
    // KEEPS the row (so the owner can fix a typo'd key with another save)
    // but reports it honestly. Reads the row regardless of is_active: a
    // soft-disabled connection must never short-circuit into a fake
    // `verified: true`.
    try {
      const conn = await getAcuityConnection(body.businessId);
      /* c8 ignore next 8 -- unreachable: we just upserted this row */
      if (!conn) {
        return successResponse({
          connection: row,
          verified: false,
          verifyError: "request_failed",
          appointmentTypes: [],
          calendars: []
        });
      }
      const account = await verifyAcuityCredentials(conn);
      const catalog = await readCatalog(body.businessId);
      // Everything past this point is bookkeeping on an ALREADY-VERIFIED
      // credential, so it gets its own guard: letting a failed timezone
      // write or row reload fall into the catch below would report
      // "Acuity rejected your credentials" about a key that just worked.
      let refreshed = row;
      try {
        // Cache the account timezone so the booking hot path never has to
        // ask Acuity what zone this merchant is in.
        if (account.timezone) {
          await setAcuityBookingDefaults(body.businessId, {
            defaultCalendarTimezone: account.timezone
          });
        }
        // Register the webhooks now that we know the key works. Best-effort
        // by contract: the poller keeps triggers correct regardless, and the
        // card explains a cap_reached / unsupported account rather than
        // failing the connect over it.
        await ensureAcuityWebhooks(
          conn,
          acuityWebhookCallbackUrl(appOrigin(request), body.businessId, conn.webhook_verification_token)
        );
        refreshed = (await getPublicAcuityConnection(body.businessId)) ?? row;
      } catch (err) {
        logger.warn("acuity connect: post-verification bookkeeping failed", {
          businessId: body.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return successResponse({
        connection: refreshed,
        verified: true,
        account,
        ...catalog
      });
    } catch (err) {
      const code = err instanceof AcuityApiError ? err.code : "request_failed";
      return successResponse({
        connection: row,
        verified: false,
        verifyError: code,
        appointmentTypes: [],
        calendars: []
      });
    }
  } catch (err) {
    if (err instanceof AcuityConnectionValidationError) {
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

    if (
      "defaultAppointmentTypeId" in body ||
      "defaultCalendarId" in body ||
      body.suppressProviderEmails !== undefined
    ) {
      await setAcuityBookingDefaults(body.businessId, {
        ...("defaultAppointmentTypeId" in body
          ? { defaultAppointmentTypeId: body.defaultAppointmentTypeId }
          : {}),
        ...("defaultCalendarId" in body ? { defaultCalendarId: body.defaultCalendarId } : {}),
        ...(body.suppressProviderEmails === undefined
          ? {}
          : { suppressProviderEmails: body.suppressProviderEmails })
      });
    }
    if (body.isActive !== undefined) {
      await setAcuityConnectionActive(body.businessId, body.isActive);
    }
    const row = await getPublicAcuityConnection(body.businessId);
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

/** Flip is_active without touching credentials. */
async function setAcuityConnectionActive(businessId: string, isActive: boolean) {
  const existing = await getPublicAcuityConnection(businessId);
  if (!existing) return;
  await upsertAcuityConnection({
    businessId,
    userId: existing.user_id,
    apiBaseUrl: existing.api_base_url,
    isActive
  });
}

export async function DELETE(request: Request) {
  try {
    const body = z.object({ businessId: z.string().uuid() }).parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    // Remove our registrations BEFORE the row goes, since teardown needs the
    // key. Best-effort: a leftover webhook pointing at a deleted tenant is
    // rejected by the receiver anyway.
    const existing = await getAcuityConnection(body.businessId);
    if (existing) await teardownAcuityWebhooks(existing);
    await deleteAcuityConnection(body.businessId);
    clearAcuityCaches();
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
