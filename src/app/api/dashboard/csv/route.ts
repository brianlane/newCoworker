/**
 * CSV import/export endpoint (modeled on the BizBlasts /manage/csv surface).
 *
 * GET  /api/dashboard/csv?businessId=<uuid>&type=contacts|employees&mode=export
 *        → text/csv download of the full dataset
 * GET  /api/dashboard/csv?businessId=<uuid>&type=contacts|employees&mode=template
 *        → text/csv template (headers + one example row)
 * POST /api/dashboard/csv?businessId=<uuid>&type=contacts|employees
 *        body: raw CSV text
 *        → { summary: { totalRows, created, updated, skipped, errors[] } }
 *
 * Imports run synchronously — files are capped (2000 rows / 1 MB) so a
 * background-job pipeline like BizBlasts' ActiveJob one is unnecessary.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_settings"); admins bypass the ownership
 * check (existing dashboard convention).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  contactsCsvTemplate,
  exportContactsCsv,
  importContactsCsv
} from "@/lib/csv/contacts";
import {
  employeesCsvTemplate,
  exportEmployeesCsv,
  importEmployeesCsv
} from "@/lib/csv/employees";
import {
  documentsCsvTemplate,
  exportDocumentsCsv,
  importDocumentsCsv
} from "@/lib/csv/documents";

export const dynamic = "force-dynamic";
// Record imports write one storage object per created row (up to 500).
export const maxDuration = 300;

const READ_RATE = { interval: 60 * 1000, maxRequests: 30 };
const IMPORT_RATE = { interval: 60 * 1000, maxRequests: 10 };

/** Import body cap — matches the row cap's order of magnitude. */
const MAX_IMPORT_BYTES = 1024 * 1024;

const querySchema = z.object({
  businessId: z.string().uuid(),
  type: z.enum(["contacts", "employees", "documents"]),
  mode: z.enum(["export", "template"]).optional()
});

function csvDownload(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    }
  });
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const parsed = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      type: url.searchParams.get("type") ?? "",
      mode: url.searchParams.get("mode") ?? "export"
    });

    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "manage_settings");

    const limiter = rateLimit(`csv-export:${parsed.businessId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const date = new Date().toISOString().slice(0, 10);
    if (parsed.mode === "template") {
      const csv =
        parsed.type === "contacts"
          ? contactsCsvTemplate()
          : parsed.type === "employees"
            ? employeesCsvTemplate()
            : documentsCsvTemplate();
      return csvDownload(csv, `${parsed.type}-template.csv`);
    }
    const csv =
      parsed.type === "contacts"
        ? await exportContactsCsv(parsed.businessId)
        : parsed.type === "employees"
          ? await exportEmployeesCsv(parsed.businessId)
          : await exportDocumentsCsv(parsed.businessId);
    return csvDownload(csv, `${parsed.type}-${date}.csv`);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const parsed = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      type: url.searchParams.get("type") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "manage_settings");

    const limiter = rateLimit(`csv-import:${parsed.businessId}`, IMPORT_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many imports, slow down.", 429);
    }

    const body = await request.text();
    if (!body.trim()) {
      return errorResponse("VALIDATION_ERROR", "Upload a CSV file first.");
    }
    if (body.length > MAX_IMPORT_BYTES) {
      return errorResponse("VALIDATION_ERROR", "File too large (max 1 MB).");
    }

    const summary =
      parsed.type === "contacts"
        ? await importContactsCsv(parsed.businessId, body)
        : parsed.type === "employees"
          ? await importEmployeesCsv(parsed.businessId, body)
          : await importDocumentsCsv(parsed.businessId, body);

    return successResponse({ summary });
  } catch (err) {
    return handleRouteError(err);
  }
}
