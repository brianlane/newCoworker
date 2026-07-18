/**
 * Owner-facing management for the business's DIRECT Calendly connection
 * (Personal Access Token — the zero-setup alternative to the Nango OAuth
 * path, mirroring /api/integrations/vagaro).
 *
 *   GET    ?businessId=…   → connection state (masked; no token material)
 *   POST   {businessId, accessToken?}
 *            → create/update the PAT, then VERIFY it end-to-end
 *              (GET /users/me) and persist the connected account's
 *              name/email for the card.
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
  CalendlyConnectionValidationError,
  deleteCalendlyConnection,
  getCalendlyConnection,
  getPublicCalendlyConnection,
  upsertCalendlyConnection
} from "@/lib/db/calendly-connections";
import { verifyCalendlyToken } from "@/lib/calendly/client";
import { teardownCalendlyWebhookSubscription } from "@/lib/calendly/webhook-subscriptions";

const businessIdSchema = z.string().uuid();

const upsertSchema = z.object({
  businessId: z.string().uuid(),
  // Optional on update (keep the stored token); required on first connect
  // (enforced by the db layer).
  accessToken: z.string().min(1).max(4096).optional()
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
    const row = await getPublicCalendlyConnection(parsed.data);
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

    await upsertCalendlyConnection(body);

    // Verify the stored token end-to-end (works for both fresh and kept
    // tokens — a soft-disabled row is verified too; disabling must never
    // fake a successful verification). On success, persist the account
    // identity so the card shows WHICH Calendly is linked.
    const conn = await getCalendlyConnection(body.businessId);
    const verification = conn
      ? await verifyCalendlyToken(conn.accessToken)
      : ({ ok: false, reason: "request_failed" } as const);
    // Success stamps the verified identity; failure CLEARS it — the card
    // must never claim "Linked to <old account>" for a token that no
    // longer verifies against that identity.
    await upsertCalendlyConnection({
      businessId: body.businessId,
      accountName: verification.ok ? verification.name : null,
      accountEmail: verification.ok ? verification.email : null
    });
    const row = await getPublicCalendlyConnection(body.businessId);
    return successResponse({
      connection: row,
      verified: verification.ok,
      ...(verification.ok ? {} : { verifyError: verification.reason })
    });
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
    const existing = await getPublicCalendlyConnection(body.businessId);
    if (!existing) return errorResponse("NOT_FOUND", "No Calendly connection");
    // Disabling also tears down the invitee.created webhook subscription
    // (best-effort, BEFORE the flip — the remote delete needs the still-
    // active token). Re-enabling needs nothing: the booking-goal sweep
    // re-creates the subscription lazily.
    if (!body.isActive) {
      await teardownCalendlyWebhookSubscription(body.businessId);
    }
    const row = await upsertCalendlyConnection({
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
    // Teardown first: the remote subscription delete needs the connection's
    // token, which is gone once the row is removed.
    await teardownCalendlyWebhookSubscription(body.businessId);
    await deleteCalendlyConnection(body.businessId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
