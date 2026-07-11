/**
 * Owner-facing: structured services catalog CRUD for the signed-in
 * account's active business (Settings → Business → Services).
 *
 *   GET    → list services
 *   POST   → create one          { name, description?, durationMinutes?, priceText?, active? }
 *   PATCH  → update one          { id, ...same fields }
 *   DELETE → remove one          { id }
 *
 * Every write re-renders `business_configs.profile_md` (the catalog is a
 * profile section) and kicks the vault sync fire-and-forget, so the agent
 * quotes new prices / books new durations without a redeploy.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteBusinessService,
  insertBusinessService,
  listBusinessServices,
  patchBusinessService,
  type BusinessServicePatch
} from "@/lib/services/db";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

const MAX_SERVICES = 50;

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  priceText: z.string().trim().max(80).optional(),
  active: z.boolean().optional()
});

async function requireActiveBusinessId(): Promise<
  { ok: true; businessId: string } | { ok: false; response: Response }
> {
  const user = await getAuthUser();
  if (!user?.email) {
    return { ok: false, response: errorResponse("UNAUTHORIZED", "Authentication required") };
  }
  const businessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  if (!businessId) {
    return { ok: false, response: errorResponse("NOT_FOUND", "No business found for this account") };
  }
  return { ok: true, businessId };
}

async function refreshGrounding(businessId: string): Promise<void> {
  await refreshBusinessProfileMdAndLog(businessId);
  void syncVaultToVpsAndLog(businessId);
}

export async function GET() {
  try {
    const auth = await requireActiveBusinessId();
    if (!auth.ok) return auth.response;
    const services = await listBusinessServices(auth.businessId);
    return successResponse({ services });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const auth = await requireActiveBusinessId();
    if (!auth.ok) return auth.response;
    const body = fieldsSchema.parse(await request.json());

    const existing = await listBusinessServices(auth.businessId);
    if (existing.length >= MAX_SERVICES) {
      return errorResponse("VALIDATION_ERROR", `Service limit reached (${MAX_SERVICES}).`);
    }
    const service = await insertBusinessService({
      id: randomUUID(),
      business_id: auth.businessId,
      name: body.name,
      description: body.description ?? "",
      duration_minutes: body.durationMinutes ?? null,
      price_text: body.priceText ?? "",
      active: body.active ?? true,
      position: existing.length
    });
    await refreshGrounding(auth.businessId);
    return successResponse({ service }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}

const patchSchema = fieldsSchema.partial().extend({ id: z.string().uuid() });

export async function PATCH(request: Request) {
  try {
    const user = await getAuthUser();
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const auth = await requireActiveBusinessId();
    if (!auth.ok) return auth.response;
    const body = patchSchema.parse(await request.json());

    const patch: BusinessServicePatch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.durationMinutes !== undefined) patch.duration_minutes = body.durationMinutes;
    if (body.priceText !== undefined) patch.price_text = body.priceText;
    if (body.active !== undefined) patch.active = body.active;
    if (Object.keys(patch).length === 0) {
      return errorResponse("VALIDATION_ERROR", "Nothing to update");
    }
    await patchBusinessService(auth.businessId, body.id, patch);
    await refreshGrounding(auth.businessId);
    return successResponse({ updated: true });
  } catch (err) {
    return handleRouteError(err);
  }
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const auth = await requireActiveBusinessId();
    if (!auth.ok) return auth.response;
    const body = deleteSchema.parse(await request.json());
    await deleteBusinessService(auth.businessId, body.id);
    await refreshGrounding(auth.businessId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
