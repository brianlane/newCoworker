/**
 * Follow Up Boss import: job lifecycle.
 *
 * POST   /api/dashboard/import/fub    body { businessId, apiKey }
 *          Validates the key against FUB with a cheap authenticated ping,
 *          stores it encrypted (encryptIntegrationSecret, the slack/meta
 *          envelope), runs the DRY RUN synchronously (counts + smart-list /
 *          action-plan inventory; writes nothing), returns the job.
 * GET    /api/dashboard/import/fub?businessId=<uuid>
 *          The business's latest job (status, counts, progress). The
 *          ciphertext never leaves the server; callers get has_api_key only.
 * DELETE /api/dashboard/import/fub?businessId=<uuid>&jobId=<uuid>
 *          Wipes the saved key (nulls the column). The job row and its
 *          result report stay.
 *
 * The real run is POST /api/dashboard/import/fub/run (its own route: it has
 * a very different time budget).
 *
 * Auth mirrors the CSV import surface: getAuthUser +
 * requireBusinessRole(businessId, "manage_settings"), admins bypass.
 * The API key is never logged and never echoed into any response or error.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { encryptIntegrationSecret } from "@/lib/integrations/secrets";
import { createFubClient, FubApiError } from "@/lib/fub-import/client";
import {
  createFubImportJob,
  dryRunFubImport,
  latestFubImportJob,
  sanitizeFubError,
  toPublicFubImportJob,
  updateFubImportJob,
  wipeFubImportJobKey
} from "@/lib/fub-import/run";

export const dynamic = "force-dynamic";
// The dry run is a handful of sequential FUB reads (rate-limit friendly).
export const maxDuration = 120;

const CREATE_RATE = { interval: 60 * 1000, maxRequests: 5 };
const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };

const createSchema = z.object({
  businessId: z.string().uuid(),
  // FUB keys are opaque tokens; only sanity-bound the length.
  apiKey: z.string().trim().min(8).max(200)
});

const querySchema = z.object({ businessId: z.string().uuid() });
const deleteSchema = z.object({ businessId: z.string().uuid(), jobId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const parsed = createSchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "manage_settings");

    const limiter = rateLimit(`fub-import-create:${parsed.businessId}`, CREATE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const client = createFubClient({ apiKey: parsed.apiKey });
    try {
      await client.ping();
    } catch (err) {
      if (err instanceof FubApiError && (err.status === 401 || err.status === 403)) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Follow Up Boss refused that API key. Copy it again from Admin, then API, in Follow Up Boss."
        );
      }
      throw err;
    }

    const db = await createSupabaseServiceClient();
    const job = await createFubImportJob(
      db,
      parsed.businessId,
      encryptIntegrationSecret(parsed.apiKey) as string,
      user.userId
    );
    try {
      const dryRun = await dryRunFubImport(client);
      const counts = { dryRun };
      await updateFubImportJob(db, parsed.businessId, job.id, {
        status: "dry_run_done",
        counts
      });
      return successResponse({
        job: toPublicFubImportJob({ ...job, status: "dry_run_done", counts })
      });
    } catch (err) {
      const message = sanitizeFubError(
        err instanceof Error ? err.message : "dry run failed",
        parsed.apiKey
      );
      await updateFubImportJob(db, parsed.businessId, job.id, {
        status: "failed",
        error: message
      });
      return errorResponse("CONFLICT", `The Follow Up Boss dry run failed: ${message}`, 502);
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

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const url = new URL(request.url);
    const parsed = deleteSchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      jobId: url.searchParams.get("jobId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(parsed.businessId, "manage_settings");

    const db = await createSupabaseServiceClient();
    const wiped = await wipeFubImportJobKey(db, parsed.businessId, parsed.jobId);
    if (wiped === 0) return errorResponse("NOT_FOUND", "Import job not found");
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
