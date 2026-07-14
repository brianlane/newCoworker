/**
 * Agents — dashboard management API.
 *
 *   GET  /api/dashboard/agents?businessId=…   → list agents
 *   POST /api/dashboard/agents                → create an agent
 *
 * An agent is a reusable attachment→output task template (name +
 * instructions + output format). Creation is manager-gated
 * (`manage_aiflows` — agents are automation definitions, same trust level
 * as flows) and tier-capped like documents.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import {
  countBusinessAgents,
  deleteBusinessAgent,
  insertBusinessAgent,
  listBusinessAgents
} from "@/lib/agents/db";
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  AGENT_NAME_MAX_CHARS,
  agentLimitForTier
} from "@/lib/agents/core";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1).max(AGENT_NAME_MAX_CHARS),
  instructions: z.string().min(1).max(AGENT_INSTRUCTIONS_MAX_CHARS),
  outputFormat: z.enum(["markdown", "same_as_input"]).default("markdown")
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "view_dashboard");

    const agents = await listBusinessAgents(businessId.data);
    return successResponse({ agents });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const body = createSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_aiflows");

    const business = await getBusiness(body.data.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);
    const limit = agentLimitForTier(business.tier);
    const existing = await countBusinessAgents(body.data.businessId);
    if (existing >= limit) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Agent limit reached for your plan (${limit}). Delete an agent or upgrade to add more.`
      );
    }

    const agent = await insertBusinessAgent({
      business_id: body.data.businessId,
      name: body.data.name.trim(),
      instructions: body.data.instructions.trim(),
      output_format: body.data.outputFormat
    });

    // Serial re-check closes the pre-insert cap race: concurrent creates can
    // each pass the count above, so anyone who lands past the cap rolls
    // their own row back (same pattern as the documents upload route).
    const afterInsert = await countBusinessAgents(body.data.businessId);
    if (afterInsert > limit) {
      await deleteBusinessAgent(body.data.businessId, agent.id);
      return errorResponse(
        "VALIDATION_ERROR",
        `Agent limit reached for your plan (${limit}). Delete an agent or upgrade to add more.`
      );
    }
    return successResponse({ agent });
  } catch (err) {
    return handleRouteError(err);
  }
}
