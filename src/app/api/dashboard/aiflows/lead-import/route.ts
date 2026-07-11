/**
 * Lead-backlog import endpoint (the "Import a lead backlog" page).
 *
 * POST /api/dashboard/aiflows/lead-import?businessId=<uuid>&mode=preview
 *   body: { csv: string }
 *   → { headers, totalRows, sampleRows, webhookFlowsEnabled, flows } — a dry
 *     run so the UI can show the parsed sheet and offer the target-flow
 *     dropdown (enabled, batch-runnable flows) before the owner commits.
 *
 * POST /api/dashboard/aiflows/lead-import?businessId=<uuid>
 *   body: { csv, source?, dripIntervalSeconds?, flowId? }
 *   → { summary }. Without flowId each row trigger-matches every enabled
 *     webhook flow (the live-bridge path); with flowId each row enqueues a
 *     run of THAT flow directly (no webhook trigger required). Runs are
 *     drip-released via earliest_claim_at (src/lib/ai-flows/lead-backlog.ts).
 *
 * The body is always CSV text: .xlsx files are converted to CSV in the
 * browser so the server never parses binary uploads.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_aiflows")
 * (admins bypass, existing dashboard convention). Imports run synchronously —
 * the sheet is capped at 500 rows / 1 MB.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { importLeadBacklog, parseLeadBacklog } from "@/lib/ai-flows/lead-backlog";
import { countEnabledWebhookFlows } from "@/lib/ai-flows/webhook-events";
import { getAiFlow, listAiFlows } from "@/lib/ai-flows/db";

export const dynamic = "force-dynamic";
// A full 500-row import runs synchronously (one flow-match + enqueue round
// trip per row); give it headroom beyond the platform default.
export const maxDuration = 300;

const IMPORT_RATE = { interval: 60 * 1000, maxRequests: 10 };

/** Body cap — matches the row cap's order of magnitude. */
const MAX_IMPORT_BYTES = 1024 * 1024;

/** Rows echoed back by preview mode for the "does this look right?" check. */
const PREVIEW_SAMPLE_ROWS = 5;

const querySchema = z.object({
  businessId: z.string().uuid(),
  mode: z.enum(["import", "preview"]).optional()
});

const bodySchema = z.object({
  csv: z.string().min(1),
  source: z.string().min(1).max(120).optional(),
  dripIntervalSeconds: z.number().int().min(0).max(3600).optional(),
  /** Target flow to run per row; omitted = trigger-match webhook flows. */
  flowId: z.string().uuid().optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const query = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      mode: url.searchParams.get("mode") ?? "import"
    });

    if (!user.isAdmin) await requireBusinessRole(query.businessId, "manage_aiflows");

    const limiter = rateLimit(`aiflow-lead-import:${query.businessId}`, IMPORT_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many imports, slow down.", 429);
    }

    const raw = (await request.json().catch(() => null)) as unknown;
    const body = bodySchema.parse(raw);
    if (body.csv.length > MAX_IMPORT_BYTES) {
      return errorResponse("VALIDATION_ERROR", "File too large (max 1 MB).", 413);
    }

    const parsed = parseLeadBacklog(body.csv);
    if (!parsed.ok) return errorResponse("VALIDATION_ERROR", parsed.error);

    if (query.mode === "preview") {
      const flows = await listAiFlows(query.businessId);
      return successResponse({
        headers: parsed.headers,
        totalRows: parsed.rows.length,
        sampleRows: parsed.rows.slice(0, PREVIEW_SAMPLE_ROWS),
        webhookFlowsEnabled: await countEnabledWebhookFlows(query.businessId),
        // Target-flow dropdown options: enabled flows the batch worker can
        // run (voice flows live on the real-time call path, so they can't
        // be a target).
        flows: flows
          .filter((f) => f.enabled && f.definition.trigger.channel !== "voice")
          .map((f) => ({ id: f.id, name: f.name }))
      });
    }

    if (body.flowId) {
      // Same gating as the Run-now route: the flow must exist for THIS
      // business, be enabled, and not be a voice flow (the batch worker has
      // no handler for call steps).
      const flow = await getAiFlow(query.businessId, body.flowId);
      if (!flow) return errorResponse("NOT_FOUND", "Flow not found", 404);
      if (!flow.enabled) {
        return errorResponse("VALIDATION_ERROR", "Enable the flow before importing into it.");
      }
      if (flow.definition.trigger.channel === "voice") {
        return errorResponse(
          "VALIDATION_ERROR",
          "Voice flows run on the live call path and can't be a lead-import target."
        );
      }
    }

    const summary = await importLeadBacklog(query.businessId, parsed.rows, {
      source: body.source,
      dripIntervalSeconds: body.dripIntervalSeconds,
      flowId: body.flowId
    });
    return successResponse({ summary });
  } catch (err) {
    return handleRouteError(err);
  }
}
