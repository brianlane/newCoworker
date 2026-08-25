/**
 * One row: change cells, or delete it.
 *
 * PATCH  .../rows/<rowId>?businessId=   body: { values?, contactId? } → { row }
 * DELETE .../rows/<rowId>?businessId=   → { ok: true }
 *
 * PATCH MERGES: only the cells sent change, so the grid can save one cell on
 * blur and the coworker can set one column without blanking the rest.
 *
 * Auth is operate_messages (staff), the same bar as the collection route:
 * working the data is data entry, not schema work.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  CustomTableError,
  attachContacts,
  deleteCustomTableRow,
  getCustomTable,
  updateCustomTableRow
} from "@/lib/custom-tables/db";
import { describeRowErrors, rowPatchSchema, validateRowValues } from "@/lib/custom-tables/core";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 120 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ tableId: z.string().uuid(), rowId: z.string().uuid() });

function customTableErrorResponse(err: CustomTableError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

async function authorize(
  request: Request,
  ctx: { params: Promise<{ tableId: string; rowId: string }> }
): Promise<
  | { error: Response }
  | { businessId: string; tableId: string; rowId: string; actor: string | null }
> {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };
  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });
  const { tableId, rowId } = paramsSchema.parse(await ctx.params);
  if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");
  const limiter = rateLimit(`custom-row-write:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many edits, slow down.", 429) };
  }
  return { businessId, tableId, rowId, actor: user.email ?? null };
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ tableId: string; rowId: string }> }
) {
  try {
    const auth = await authorize(request, ctx);
    if ("error" in auth) return auth.error;
    const { businessId, tableId, rowId, actor } = auth;
    const body = rowPatchSchema.parse(await request.json());

    try {
      const table = await getCustomTable(businessId, tableId);
      let values: Record<string, never> | undefined;
      let clear: string[] | undefined;
      if (body.values) {
        // PARTIAL: a one-cell save sends only that cell, and a column
        // nobody mentioned is a column nobody is touching. Validating the
        // whole row here would report every other required column as
        // missing, so marking one column required would freeze the grid.
        const checked = validateRowValues(table.fields, body.values, { partial: true });
        if (!checked.ok) {
          return errorResponse("VALIDATION_ERROR", describeRowErrors(table.fields, checked.errors));
        }
        values = checked.values as Record<string, never>;
        // Cells the caller sent as blank. Without passing these through, a
        // merge could add and change cells but never empty one, so a typo
        // in a cell could be corrected but never simply removed.
        clear = checked.cleared;
      }
      const row = await updateCustomTableRow(
        table,
        rowId,
        {
          values,
          clear,
          // A standalone table has nobody to point at, so a contactId sent
          // at one is dropped rather than silently stored where no reader
          // would ever look for it.
          ...(body.contactId !== undefined && table.rowLink === "contact"
            ? { contactId: body.contactId }
            : {})
        },
        { source: "dashboard", actor }
      );
      // Answer with the SAME shape the list returns, contact name included.
      // That lets the client update this one row in place; reloading the
      // grid instead would race an in-flight cell save and could paint a
      // stale value over a write that already succeeded.
      const [joined] = await attachContacts(businessId, [row]);
      return successResponse({ row: joined });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ tableId: string; rowId: string }> }
) {
  try {
    const auth = await authorize(request, ctx);
    if ("error" in auth) return auth.error;
    const { businessId, tableId, rowId, actor } = auth;
    try {
      // Prove the table belongs to THIS business before touching its rows.
      // deleteCustomTableRow scopes to the table, so without this the URL
      // could name another tenant's table id and the row would go.
      await getCustomTable(businessId, tableId);
      await deleteCustomTableRow(tableId, rowId, { source: "dashboard", actor });
      return successResponse({ ok: true });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
