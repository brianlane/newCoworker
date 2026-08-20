/**
 * Follow Up Boss import: the real run.
 *
 * POST /api/dashboard/import/fub/run   body { businessId, jobId }
 *
 * Executes import pages (people, then notes, then deals) inside this
 * invocation's time budget, persisting counts + cursor to the job row after
 * every page. When the budget runs out before the import finishes, the
 * response says status "running" and the dashboard simply POSTs again: the
 * cursor resumes exactly where the last page ended. Repeat until "done".
 *
 * Requires a job whose dry run completed (or a run already in progress) and
 * whose saved key has not been wiped. Auth and rate limiting mirror the CSV
 * import surface (manage_settings, admins bypass).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { decryptIntegrationSecret } from "@/lib/integrations/secrets";
import { createFubClient } from "@/lib/fub-import/client";
import {
  getFubImportJob,
  runFubImportChunk,
  sanitizeFubError,
  toPublicFubImportJob,
  updateFubImportJob
} from "@/lib/fub-import/run";

export const dynamic = "force-dynamic";
// Same ceiling as the CSV import route; the engine stops itself well before.
export const maxDuration = 300;

/**
 * Per-invocation import budget. Under the 300s ceiling with headroom for
 * the page in flight when the budget expires plus the final persist.
 */
const RUN_BUDGET_MS = 240_000;

const RUN_RATE = { interval: 60 * 1000, maxRequests: 20 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  jobId: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const parsed = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "manage_settings");

    const limiter = rateLimit(`fub-import-run:${parsed.businessId}`, RUN_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const db = await createSupabaseServiceClient();
    const job = await getFubImportJob(db, parsed.businessId, parsed.jobId);
    if (!job) return errorResponse("NOT_FOUND", "Import job not found");
    // A failed REAL run may resume (its cursor is still valid); a job whose
    // dry run never completed has nothing to resume from. dry_run stays true
    // only until runFubImportChunk claims the job, which it does before its
    // first Follow Up Boss call, so `failed && dry_run` is exactly "this job
    // never got past its preview" and never "the import died early".
    if (job.status === "pending" || (job.status === "failed" && job.dry_run)) {
      return errorResponse(
        "CONFLICT",
        "Run the dry run first, then start the import from its results."
      );
    }
    const apiKey = decryptIntegrationSecret(job.api_key_encrypted);
    if (!apiKey) {
      return errorResponse(
        "CONFLICT",
        "The saved Follow Up Boss key was deleted. Start a new import to continue."
      );
    }

    const client = createFubClient({ apiKey });
    try {
      const result = await runFubImportChunk(db, client, job, {
        deadlineMs: Date.now() + RUN_BUDGET_MS
      });
      const refreshed = await getFubImportJob(db, parsed.businessId, parsed.jobId);
      return successResponse({
        status: result.status,
        job: refreshed ? toPublicFubImportJob(refreshed) : null
      });
    } catch (err) {
      const message = sanitizeFubError(
        err instanceof Error ? err.message : "import failed",
        apiKey
      );
      await updateFubImportJob(db, parsed.businessId, parsed.jobId, {
        status: "failed",
        error: message
      });
      return errorResponse("CONFLICT", `The import stopped: ${message}`, 502);
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
