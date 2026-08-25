/**
 * Recent changes to one custom table, and putting one back.
 *
 * GET  .../versions?businessId=  → { entries }
 * POST .../versions?businessId=  body: { versionId } → { outcome }
 *
 * The entries are already plain English: the pairing that turns a
 * "state before" snapshot into "what the change DID" lives in
 * src/lib/custom-tables/version-history.ts, with tests, rather than in a
 * component where nothing would check the off-by-one.
 *
 * Auth: reading is view_dashboard; restoring is manage_settings, because an
 * undo can bring back a whole table.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { CustomTableError, getCustomTable, listCustomTableRows } from "@/lib/custom-tables/db";
import {
  listCustomTableVersions,
  restoreCustomTableVersion
} from "@/lib/custom-tables/versions";
import { buildCustomTableHistory } from "@/lib/custom-tables/version-history";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ tableId: z.string().uuid() });
const restoreSchema = z.object({ versionId: z.number().int().positive() }).strict();

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

    const limiter = rateLimit(`custom-versions:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    try {
      const table = await getCustomTable(businessId, tableId);
      const [versions, page] = await Promise.all([
        listCustomTableVersions(businessId, tableId),
        listCustomTableRows(tableId, table.fields)
      ]);
      // A row edit is described against that row as it stands NOW, so the
      // live values ride along. A row that has since been deleted is simply
      // absent, which the builder reads as "changed a row that went away".
      const live = new Map(page.rows.map((r) => [r.id, r.values as Record<string, unknown>]));
      return successResponse({ entries: buildCustomTableHistory(versions, table, live) });
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
    paramsSchema.parse(await ctx.params);
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`custom-restore:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const { versionId } = restoreSchema.parse(await request.json());
    try {
      const outcome = await restoreCustomTableVersion(businessId, versionId, {
        source: "dashboard_restore",
        actor: user.email ?? null
      });
      return successResponse({ outcome });
    } catch (err) {
      if (err instanceof CustomTableError) return customTableErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
