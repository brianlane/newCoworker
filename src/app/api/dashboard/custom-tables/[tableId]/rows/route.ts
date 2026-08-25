/**
 * Rows inside one custom table.
 *
 * GET  /api/dashboard/custom-tables/<id>/rows?businessId=&cursor=&limit=&contactId=&q=
 *        → { table, rows, nextCursor }
 * POST /api/dashboard/custom-tables/<id>/rows?businessId=
 *        body: { values, contactId? } → { row }
 *
 * AUTHORIZATION, the one call worth arguing about: defining a table is
 * manage_settings (manager+), because it is schema. FILLING one in is
 * operate_messages (staff), because adding a row is data entry, the same act
 * as create_contact. Gating rows at manage_settings would mean staff can
 * text a customer but not log the call. A test pins this so a refactor
 * cannot quietly move the bar.
 *
 * The write limit is deliberately 120/min, not the usual 60: the grid saves
 * a cell on blur, and 60/min is one edit per second.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  CustomTableError,
  createCustomTableRow,
  getCustomTable,
  listCustomTableRowsWithContacts
} from "@/lib/custom-tables/db";
import {
  describeRowErrors,
  matchRowsByQuery,
  rowCreateSchema,
  rowListFilterSchema,
  validateRowValues
} from "@/lib/custom-tables/core";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 120 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ tableId: z.string().uuid() });

function customTableErrorResponse(err: CustomTableError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
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

    const limiter = rateLimit(`custom-rows:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const filter = rowListFilterSchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      contactId: url.searchParams.get("contactId") ?? undefined,
      q: url.searchParams.get("q") ?? undefined
    });

    try {
      const table = await getCustomTable(businessId, tableId);
      const page = await listCustomTableRowsWithContacts(businessId, tableId, table.fields, {
        limit: filter.limit,
        cursor: filter.cursor ?? null,
        contactId: filter.contactId
      });
      // Search runs over the page, not the whole table: the grid is a page
      // at a time either way, and a server-side jsonb text search over
      // owner-defined columns would need an index per tenant shape.
      const rows = filter.q ? matchRowsByQuery(table.fields, page.rows, filter.q) : page.rows;
      return successResponse({ table, rows, nextCursor: page.nextCursor });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ tableId: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    const { tableId } = paramsSchema.parse(await ctx.params);
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`custom-rows-write:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = rowCreateSchema.parse(await request.json());
    try {
      const table = await getCustomTable(businessId, tableId);
      const checked = validateRowValues(table.fields, body.values);
      if (!checked.ok) {
        return errorResponse("VALIDATION_ERROR", describeRowErrors(table.fields, checked.errors));
      }
      const row = await createCustomTableRow(
        businessId,
        table,
        {
          values: checked.values,
          contactId: table.rowLink === "contact" ? (body.contactId ?? null) : null,
          createdBy: user.userId
        },
        { source: "dashboard", actor: user.email ?? null }
      );
      return successResponse({ row });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
