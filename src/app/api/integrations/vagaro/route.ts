/**
 * Owner-facing management for the business's Vagaro connection.
 *
 *   GET    ?businessId=…   → connection state (masked; no secret material)
 *   POST   {businessId, clientId, clientSecret?, apiBaseUrl?}
 *            → create/update credentials, then VERIFY them by exchanging a
 *              token + listing services; the services come back so the card
 *              can render the default-service picker immediately.
 *   PATCH  {businessId, defaultServiceId?, defaultEmployeeId?, isActive?}
 *            → booking defaults / soft-disable.
 *   DELETE {businessId}    → remove the connection entirely.
 *
 * Auth mirrors the custom-integrations routes: owner/manager session with
 * `manage_settings` on the business (admins bypass). This surface manages
 * the credential vault; the agent never calls it.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteVagaroConnection,
  getActiveVagaroConnection,
  getPublicVagaroConnection,
  getVagaroConnection,
  setVagaroBookingDefaults,
  upsertVagaroConnection,
  VagaroConnectionValidationError
} from "@/lib/db/vagaro-connections";
import { clearVagaroTokenCache, listVagaroServices, VagaroApiError } from "@/lib/vagaro/client";

const businessIdSchema = z.string().uuid();

const upsertSchema = z.object({
  businessId: z.string().uuid(),
  clientId: z.string().min(1).max(200),
  // Optional on update (keep the stored secret); required on first connect
  // (enforced by the db layer). Length-bounded like custom integrations.
  clientSecret: z.string().min(1).max(4096).optional(),
  apiBaseUrl: z.string().url().max(200).optional()
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  defaultServiceId: z.string().max(120).nullable().optional(),
  defaultEmployeeId: z.string().max(120).nullable().optional(),
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await authorize(parsed.data);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const row = await getPublicVagaroConnection(parsed.data);

    // `?services=1` — live service catalog for the default-service picker.
    if (url.searchParams.get("services") === "1" && row) {
      try {
        const conn = await getActiveVagaroConnection(parsed.data);
        const services = conn ? await listVagaroServices(conn) : [];
        return successResponse({ connection: row, services, servicesError: null });
      } catch (err) {
        const code = err instanceof VagaroApiError ? err.code : "request_failed";
        return successResponse({ connection: row, services: [], servicesError: code });
      }
    }
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

    const row = await upsertVagaroConnection(body);
    // Credential rotation must not serve a token minted from the old secret.
    clearVagaroTokenCache();

    // Verify the credentials end-to-end and hand back the service catalog
    // for the default-service picker. A failed verification keeps the row
    // (the owner can fix a typo'd secret with another save) but reports it.
    // Verification reads the row regardless of is_active — a soft-disabled
    // connection must never short-circuit into a fake `verified: true`.
    try {
      const conn = await getVagaroConnection(body.businessId);
      if (!conn) {
        // Unreachable in practice (we just upserted), but never claim a
        // verification we didn't perform.
        return successResponse({
          connection: row,
          verified: false,
          verifyError: "request_failed",
          services: []
        });
      }
      const services = await listVagaroServices(conn);
      return successResponse({ connection: row, verified: true, services });
    } catch (err) {
      const code = err instanceof VagaroApiError ? err.code : "request_failed";
      return successResponse({
        connection: row,
        verified: false,
        verifyError: code,
        services: []
      });
    }
  } catch (err) {
    if (err instanceof VagaroConnectionValidationError) {
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

    if ("defaultServiceId" in body || "defaultEmployeeId" in body) {
      await setVagaroBookingDefaults(body.businessId, {
        ...("defaultServiceId" in body ? { defaultServiceId: body.defaultServiceId } : {}),
        ...("defaultEmployeeId" in body ? { defaultEmployeeId: body.defaultEmployeeId } : {})
      });
    }
    if (body.isActive !== undefined) {
      await upsertVagaroConnectionActive(body.businessId, body.isActive);
    }
    const row = await getPublicVagaroConnection(body.businessId);
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

/** Flip is_active without touching credentials. */
async function upsertVagaroConnectionActive(businessId: string, isActive: boolean) {
  const existing = await getPublicVagaroConnection(businessId);
  if (!existing) return;
  await upsertVagaroConnection({
    businessId,
    clientId: existing.client_id,
    apiBaseUrl: existing.api_base_url,
    isActive
  });
}

export async function DELETE(request: Request) {
  try {
    const body = z
      .object({ businessId: z.string().uuid() })
      .parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    await deleteVagaroConnection(body.businessId);
    clearVagaroTokenCache();
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
