/**
 * One custom table: rename it, edit its columns, delete it, restore it.
 *
 * PATCH  /api/dashboard/custom-tables/<id>?businessId=<uuid>
 *          body: discriminated union on `action`:
 *            rename | update_details | add_field | update_field
 *            | reorder_fields | delete_field
 *          → { table, swept? }
 * DELETE /api/dashboard/custom-tables/<id>?businessId=<uuid>  → { ok: true }
 * POST   /api/dashboard/custom-tables/<id>?businessId=<uuid>  (restore)
 *          → { table }
 *
 * Auth: manage_settings throughout. Changing a table's shape is schema work,
 * the same bar as pipelines; working the DATA inside it is staff work and
 * lives on the rows route.
 *
 * The delete is SOFT. The table comes back with one stamp-clear, which is
 * what makes it safe for the coworker to delete one on request.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  CustomTableError,
  getCustomTable,
  patchCustomTableFields,
  restoreCustomTable,
  softDeleteCustomTable,
  updateCustomTableDetails
} from "@/lib/custom-tables/db";
import { tablePatchSchema } from "@/lib/custom-tables/core";
import type { FieldDefinitionPatch } from "@/lib/custom-tables/core";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ tableId: z.string().uuid() });

function customTableErrorResponse(err: CustomTableError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

/** Shared auth + parse for all three verbs. */
async function authorize(
  request: Request,
  ctx: { params: Promise<{ tableId: string }> }
): Promise<
  | { error: Response }
  | { businessId: string; tableId: string; userId: string; actor: string | null }
> {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };

  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });
  const { tableId } = paramsSchema.parse(await ctx.params);
  if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

  const limiter = rateLimit(`custom-table-write:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many edits, slow down.", 429) };
  }
  return { businessId, tableId, userId: user.userId, actor: user.email ?? null };
}

export async function PATCH(request: Request, ctx: { params: Promise<{ tableId: string }> }) {
  try {
    const auth = await authorize(request, ctx);
    if ("error" in auth) return auth.error;
    const { businessId, tableId, actor } = auth;
    const edit = { source: "dashboard", actor };
    const body = tablePatchSchema.parse(await request.json());

    try {
      if (body.action === "rename") {
        const table = await updateCustomTableDetails(businessId, tableId, { name: body.name }, edit);
        return successResponse({ table });
      }
      if (body.action === "update_details") {
        const table = await updateCustomTableDetails(
          businessId,
          tableId,
          { description: body.description ?? null, icon: body.icon },
          edit
        );
        return successResponse({ table });
      }

      const patch: FieldDefinitionPatch =
        body.action === "add_field"
          ? {
              action: "add",
              label: body.field.label,
              type: body.field.type,
              help: body.field.help,
              options: body.field.options,
              required: body.field.required
            }
          : body.action === "update_field"
            ? {
                action: "update",
                fieldId: body.fieldId,
                label: body.label,
                help: body.help,
                options: body.options,
                required: body.required,
                enabled: body.enabled
              }
            : body.action === "reorder_fields"
              ? { action: "reorder", fieldIds: body.fieldIds }
              : { action: "remove", fieldId: body.fieldId };

      const { table, sweptRows } = await patchCustomTableFields(businessId, tableId, patch, edit);
      return successResponse({ table, swept: sweptRows });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ tableId: string }> }) {
  try {
    const auth = await authorize(request, ctx);
    if ("error" in auth) return auth.error;
    const { businessId, tableId, userId, actor } = auth;
    try {
      await softDeleteCustomTable(businessId, tableId, userId, { source: "dashboard", actor });
      return successResponse({ ok: true });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

/** Restore from the trash. POST rather than PATCH: the table is not live
 * yet, so there is nothing for a patch verb to act on. */
export async function POST(request: Request, ctx: { params: Promise<{ tableId: string }> }) {
  try {
    const auth = await authorize(request, ctx);
    if ("error" in auth) return auth.error;
    const { businessId, tableId, actor } = auth;
    try {
      const table = await restoreCustomTable(businessId, tableId, {
        source: "dashboard_restore",
        actor
      });
      return successResponse({ table });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ tableId: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    const { tableId } = paramsSchema.parse(await ctx.params);
    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");
    try {
      return successResponse({ table: await getCustomTable(businessId, tableId) });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
