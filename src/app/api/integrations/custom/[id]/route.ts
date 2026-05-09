/**
 * Item-level CRUD for `custom_integrations` (GET/PATCH/DELETE).
 *
 * Auth: owner-only. The dashboard UI uses this for edit/delete.
 *
 * GET returns the public shape (`has_secret` boolean instead of the
 * cleartext) so the edit form can show "Replace stored secret" UX
 * without ever holding the cleartext in browser memory.
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import {
  errorResponse,
  handleRouteError,
  successResponse
} from "@/lib/api-response";
import {
  CUSTOM_AUTH_SCHEMES,
  CustomIntegrationValidationError,
  deleteCustomIntegration,
  getCustomIntegrationById,
  updateCustomIntegration
} from "@/lib/db/custom-integrations";

const idSchema = z.string().uuid();

const patchSchema = z.object({
  businessId: z.string().uuid(),
  label: z.string().min(1).max(80),
  baseUrl: z.string().url(),
  authScheme: z.enum(CUSTOM_AUTH_SCHEMES),
  headerName: z.string().min(1).max(128).optional().nullable(),
  // `secret === undefined` means "leave existing alone" (the form sends
  // an empty string when the user wants to keep the current value, and
  // we strip empties to undefined client-side); `secret === null` means
  // "clear the stored secret" (only valid for scheme=none on the server).
  secret: z.string().max(4096).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional()
});

const deleteSchema = z.object({ businessId: z.string().uuid() });

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }
    const { id } = await params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("VALIDATION_ERROR", "id is invalid");
    }
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    if (!businessId || !idSchema.safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    if (!user.isAdmin) {
      await requireOwner(businessId);
    }
    const row = await getCustomIntegrationById(businessId, id);
    if (!row) {
      return errorResponse("NOT_FOUND", "Custom integration not found");
    }
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }
    const { id } = await params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("VALIDATION_ERROR", "id is invalid");
    }
    const body = patchSchema.parse(await request.json());
    if (!user.isAdmin) {
      await requireOwner(body.businessId);
    }
    const row = await updateCustomIntegration({ ...body, id });
    return successResponse(row);
  } catch (err) {
    if (err instanceof CustomIntegrationValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    if (
      err instanceof Error &&
      /duplicate key|unique constraint/i.test(err.message)
    ) {
      return errorResponse(
        "CONFLICT",
        "A custom integration with this label already exists"
      );
    }
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }
    const { id } = await params;
    if (!idSchema.safeParse(id).success) {
      return errorResponse("VALIDATION_ERROR", "id is invalid");
    }
    const body = deleteSchema.parse(await request.json().catch(() => ({})));
    if (!user.isAdmin) {
      await requireOwner(body.businessId);
    }
    await deleteCustomIntegration(body.businessId, id);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
