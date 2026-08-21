/**
 * Follow Up Boss import from the owner's own CSV export.
 *
 * POST /api/dashboard/import/fub?businessId=<uuid>&dryRun=<true|false>
 *        Body is the raw CSV text (text/csv), the same shape the contacts
 *        import route takes. dryRun=true parses and reports; dryRun=false
 *        applies. Either way a job row records what happened.
 * GET  /api/dashboard/import/fub?businessId=<uuid>
 *        The business's latest job, for the status card.
 *
 * There is no API key on this surface and nothing to store: the file is sent
 * for the preview, sent again to import, and never parked in the database.
 * See src/lib/fub-import/run.ts for why this is a CSV and not their API.
 *
 * Auth mirrors the CSV import surface: getAuthUser +
 * requireBusinessRole(businessId, "manage_settings"), admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createFubImportJob,
  importFubCsv,
  latestFubImportJob,
  previewFubCsv,
  toPublicFubImportJob,
  updateFubImportJob
} from "@/lib/fub-import/run";

export const dynamic = "force-dynamic";
// A real import is up to MAX_IMPORT_ROWS sequential contact upserts, each
// possibly firing a contact event; the contacts CSV route budgets the same.
export const maxDuration = 300;

/** Matches the contacts CSV import cap. */
const MAX_IMPORT_BYTES = 1024 * 1024;

const IMPORT_RATE = { interval: 60 * 1000, maxRequests: 10 };
const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };

const postSchema = z.object({
  businessId: z.string().uuid(),
  dryRun: z.enum(["true", "false"])
});

const querySchema = z.object({ businessId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const parsed = postSchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      dryRun: url.searchParams.get("dryRun") ?? "true"
    });
    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "manage_settings");

    const limiter = rateLimit(`fub-import:${parsed.businessId}`, IMPORT_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many imports, slow down.", 429);
    }

    const body = await request.text();
    if (!body.trim()) {
      return errorResponse("VALIDATION_ERROR", "Upload your Follow Up Boss export first.");
    }
    if (body.length > MAX_IMPORT_BYTES) {
      return errorResponse("VALIDATION_ERROR", "File too large (max 1 MB).");
    }

    // Parse BEFORE creating a job row: a file we cannot read is the owner's
    // to fix, not an import attempt worth recording.
    const parse = previewFubCsv(body);
    if (!parse.ok) return errorResponse("VALIDATION_ERROR", parse.error);

    const dryRun = parsed.dryRun === "true";
    const db = await createSupabaseServiceClient();
    const job = await createFubImportJob(db, parsed.businessId, user.userId, dryRun);

    if (dryRun) {
      const counts = { preview: parse.preview };
      await updateFubImportJob(db, parsed.businessId, job.id, {
        status: "dry_run_done",
        counts
      });
      return successResponse({
        job: toPublicFubImportJob({ ...job, status: "dry_run_done", counts })
      });
    }

    try {
      const summary = await importFubCsv(db, parsed.businessId, job.id, parse);
      const counts = { preview: parse.preview, summary };
      await updateFubImportJob(db, parsed.businessId, job.id, { status: "done", counts });
      return successResponse({ job: toPublicFubImportJob({ ...job, status: "done", counts }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "import failed";
      await updateFubImportJob(db, parsed.businessId, job.id, {
        status: "failed",
        error: message
      });
      return errorResponse("CONFLICT", `The import failed: ${message}`, 502);
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const url = new URL(request.url);
    const parsed = querySchema.parse({ businessId: url.searchParams.get("businessId") ?? "" });
    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "manage_settings");

    const limiter = rateLimit(`fub-import-read:${parsed.businessId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const db = await createSupabaseServiceClient();
    const job = await latestFubImportJob(db, parsed.businessId);
    return successResponse({ job: job ? toPublicFubImportJob(job) : null });
  } catch (err) {
    return handleRouteError(err);
  }
}
