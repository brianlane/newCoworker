/**
 * Custom tables: the owner's own tables (Airtable-style).
 *
 * GET  /api/dashboard/custom-tables?businessId=<uuid>&includeDeleted=1
 *        → { tables, rowCounts, deleted }
 *
 * POST /api/dashboard/custom-tables?businessId=<uuid>
 *        body: { name, description?, icon?, rowLink?, fields: [...] }
 *        → { table }
 *
 * Auth: reading needs view_dashboard (staff work the data); DEFINING a table
 * needs manage_settings (manager+), because a table is schema, the same bar
 * as pipelines. Filling one in is a different bar, see the rows route.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  CustomTableError,
  countRowsByTable,
  createCustomTable,
  listCustomTables,
  listDeletedCustomTables
} from "@/lib/custom-tables/db";
import { slugifyFieldId, tableCreateSchema } from "@/lib/custom-tables/core";
import type { CustomTableField, CustomTableRowLink } from "@/lib/custom-tables/types";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({ businessId: z.string().uuid() });

/** Map a typed lib failure onto the right HTTP class (route-local; Next
 * route modules may only export handlers). */
function customTableErrorResponse(err: CustomTableError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");

    const limiter = rateLimit(`custom-tables:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    // The trash comes back for everyone who can read the tables, and the
    // directory renders the restore control only for people who can use it.
    // Gating the QUERY instead would put the safety net out of reach of the
    // owner, which is the person most likely to need it: the coworker can
    // delete a table on request, and "bring it back" has to be one click
    // away rather than an admin errand.
    const [tables, counts, deleted] = await Promise.all([
      listCustomTables(businessId),
      countRowsByTable(businessId),
      listDeletedCustomTables(businessId)
    ]);
    return successResponse({
      tables,
      rowCounts: Object.fromEntries(counts),
      deleted
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`custom-tables-write:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = tableCreateSchema.parse(await request.json());
    // Ids are generated here, never accepted from the client: they are what
    // every stored row keys on, so letting a caller pick one would let a
    // typo silently point at another column's data.
    const fields: CustomTableField[] = [];
    for (const draft of body.fields) {
      const options = draft.options?.map((o) => o.trim()).filter((o) => o.length > 0);
      fields.push({
        id: slugifyFieldId(draft.label, fields.map((f) => f.id)),
        label: draft.label,
        ...(draft.help ? { help: draft.help } : {}),
        type: draft.type,
        ...(options && options.length > 0 ? { options } : {}),
        required: draft.required === true,
        enabled: true
      });
    }

    try {
      const table = await createCustomTable(businessId, {
        name: body.name,
        description: body.description ?? null,
        icon: body.icon ?? null,
        rowLink: (body.rowLink ?? "standalone") as CustomTableRowLink,
        fields,
        createdBy: user.userId
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
