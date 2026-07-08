/**
 * Settings → Coworker tools.
 *
 * GET  ?businessId=  → the full worker/tool catalog (code registry) merged
 *                      with this tenant's overrides — what the page renders.
 * PUT  { businessId, agentKey, toolKey, enabled }
 *                    → flip one tool. Rejected for tools the registry marks
 *                      non-configurable (no platform enforcement point) or
 *                      that don't exist — the table must never accumulate
 *                      rows the enforcement layer won't honor.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_settings") (admin bypasses ownership,
 * same as /api/dashboard/chat).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { findAgentToolDefinition } from "@/lib/agent-tools/registry";
import { resolveAgentTools, upsertAgentToolSetting } from "@/lib/db/agent-tool-settings";
import type { AgentKey } from "@/lib/agent-tools/registry";

export const dynamic = "force-dynamic";

const businessIdSchema = z.string().uuid();

const putBodySchema = z.object({
  businessId: z.string().uuid(),
  agentKey: z.enum(["dashboard", "voice", "sms"]),
  toolKey: z.string().min(1).max(100),
  enabled: z.boolean()
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const businessId = businessIdSchema.parse(url.searchParams.get("businessId") ?? "");
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const agents = await resolveAgentTools(businessId);
    return successResponse({ agents });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = putBodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    const def = findAgentToolDefinition(body.agentKey, body.toolKey);
    if (!def) {
      return errorResponse("NOT_FOUND", "Unknown worker tool");
    }
    if (!def.tool.configurable) {
      return errorResponse(
        "VALIDATION_ERROR",
        `${def.tool.label} is managed by the platform and can't be toggled.`
      );
    }

    const row = await upsertAgentToolSetting({
      businessId: body.businessId,
      agentKey: body.agentKey as AgentKey,
      toolKey: body.toolKey,
      enabled: body.enabled
    });

    return successResponse({
      agentKey: row.agent_key,
      toolKey: row.tool_key,
      enabled: row.enabled
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
