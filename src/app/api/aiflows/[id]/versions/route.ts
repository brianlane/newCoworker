/**
 * Edit history for one AiFlow, and putting an earlier version back.
 *
 * The history has existed since PR #1446 (an `ai_flow_definition_versions`
 * table filled by a database trigger, read through src/lib/ai-flows/versions.ts)
 * but only the AI could reach it: the inline `undo_aiflow_edit` tool and the
 * MCP `restore_flow_version` tool. An owner who broke a flow in the builder
 * had no way back. This route is the dashboard's half of that.
 *
 * GET  ?businessId=<uuid>            -> history entries, newest first
 * POST { businessId, versionId? }    -> restore (omit versionId to undo the
 *                                       most recent edit)
 *
 * Restoring goes through `restoreFlowVersion`, so it re-validates like any
 * other edit and the trigger snapshots the state being replaced: an undo is
 * itself undoable, and clicking Restore on the wrong row is not terminal.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAiFlow } from "@/lib/ai-flows/db";
import { listFlowVersions, restoreFlowVersion } from "@/lib/ai-flows/versions";
import { buildFlowHistory } from "@/lib/ai-flows/version-history";

const idSchema = z.string().uuid();

const restoreSchema = z.object({
  businessId: z.string().uuid(),
  /** Omitted = undo the most recent edit, the same default the AI tool uses. */
  versionId: z.number().int().positive().optional()
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const businessId = new URL(request.url).searchParams.get("businessId");
    if (!businessId || !idSchema.safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_aiflows");

    // The live row is half of every diff (the newest snapshot is described by
    // what replaced it, which is the current definition), so a missing flow is
    // a 404 rather than a history with an unexplained top entry.
    const flow = await getAiFlow(businessId, id);
    if (!flow) return errorResponse("NOT_FOUND", "AiFlow not found");

    const versions = await listFlowVersions(businessId, id);
    return successResponse({
      entries: buildFlowHistory(versions, { name: flow.name, definition: flow.definition })
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const body = restoreSchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");

    const result = await restoreFlowVersion(body.businessId, id, {
      ...(body.versionId !== undefined ? { versionId: body.versionId } : {}),
      editSource: "dashboard_restore",
      editActor: user.email
    });
    // restoreFlowVersion reports a refusal in its own words (no history, an
    // id that is not in this flow's history, a definition the validator now
    // rejects) and leaves the flow untouched. Relay that instead of a generic
    // failure, and never as a success.
    if (!result.ok) return errorResponse("VALIDATION_ERROR", result.message);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
