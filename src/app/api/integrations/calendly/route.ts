/**
 * Owner-facing management for the business's DIRECT Calendly connections
 * (Personal Access Tokens, the zero-setup alternative to the Nango OAuth
 * path, mirroring /api/integrations/vagaro).
 *
 * A business can link SEVERAL Calendly accounts (one row per account):
 * teammates who book on their own Calendly connect their own PAT and the
 * booking machinery unions events across all of them.
 *
 *   GET    ?businessId=…   → { connections: [...] } (masked; oldest first)
 *   POST   {businessId, accessToken}
 *            → VERIFY the token first (GET /users/me), then save: a token
 *              for a not-yet-linked account creates a new connection; a
 *              token for an already-linked account converges onto that row
 *              (token + identity refresh). Nothing is stored for a token
 *              that fails verification.
 *   PATCH  {businessId, connectionId, isActive}  → soft-disable/re-enable.
 *   DELETE {businessId, connectionId}            → remove one connection.
 *
 * Auth mirrors the other integration routes: owner/manager session with
 * `manage_settings` on the business (admins bypass).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  CalendlyConnectionValidationError,
  deleteCalendlyConnection,
  getCalendlyConnectionById,
  listPublicCalendlyConnections,
  saveCalendlyConnection,
  setCalendlyConnectionActive
} from "@/lib/db/calendly-connections";
import { verifyCalendlyToken } from "@/lib/calendly/client";
import { teardownCalendlyWebhookSubscription } from "@/lib/calendly/webhook-subscriptions";

const businessIdSchema = z.string().uuid();

const createSchema = z.object({
  businessId: z.string().uuid(),
  accessToken: z.string().min(1).max(4096)
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().uuid(),
  isActive: z.boolean()
});

const deleteSchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().uuid()
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
    const connections = await listPublicCalendlyConnections(parsed.data);
    return successResponse({ connections });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = createSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // Verify BEFORE saving: a token that does not work is never stored, and
    // the verified user URI is the account identity that decides whether
    // this creates a new connection or refreshes an existing one. (The old
    // single-connection route saved first and verified after; with several
    // rows the account must be known before choosing the row.)
    const verification = await verifyCalendlyToken(body.accessToken);
    if (!verification.ok) {
      return successResponse({
        connection: null,
        verified: false,
        verifyError: verification.reason
      });
    }

    const { connection, created } = await saveCalendlyConnection({
      businessId: body.businessId,
      accessToken: body.accessToken,
      userUri: verification.userUri,
      accountName: verification.name ?? null,
      accountEmail: verification.email ?? null
    });
    return successResponse({ connection, created, verified: true });
  } catch (err) {
    if (err instanceof CalendlyConnectionValidationError) {
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
    // Disabling also tears down THIS connection's invitee.created webhook
    // subscription (best-effort, BEFORE the flip, the remote delete needs
    // the still-active token). Re-enabling needs nothing: the booking-goal
    // sweep re-creates subscriptions lazily.
    if (!body.isActive) {
      await teardownCalendlyWebhookSubscription(body.businessId, body.connectionId);
    }
    const row = await setCalendlyConnectionActive(
      body.businessId,
      body.connectionId,
      body.isActive
    );
    if (!row) return errorResponse("NOT_FOUND", "No such Calendly connection");
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = deleteSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const existing = await getCalendlyConnectionById(body.businessId, body.connectionId);
    if (!existing) return errorResponse("NOT_FOUND", "No such Calendly connection");
    // Teardown first: the remote subscription delete needs the connection's
    // token, which is gone once the row is removed.
    await teardownCalendlyWebhookSubscription(body.businessId, body.connectionId);
    await deleteCalendlyConnection(body.businessId, body.connectionId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
