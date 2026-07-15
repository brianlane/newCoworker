/**
 * Owner-facing CRUD for AiFlows (list + create).
 *
 * Auth: owner-only (Supabase session); RLS on `ai_flows` enforces the same
 * boundary. The `definition` is validated by `parseAiFlowDefinition` inside the
 * db layer, so an invalid automation 400s instead of being persisted.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createAiFlow, listAiFlows } from "@/lib/ai-flows/db";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { validateShareDocumentSteps } from "@/lib/ai-flows/document-steps";
import { validateRunAgentSteps } from "@/lib/ai-flows/agent-steps";

const businessIdSchema = z.string().uuid();

const createSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  definition: z.unknown()
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const parsed = businessIdSchema.safeParse(businessId);
    if (!parsed.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(parsed.data, "manage_aiflows");
    const rows = await listAiFlows(parsed.data);
    return successResponse(rows);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = createSchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");
    // share_document steps must reference a real, ready, client-audience,
    // non-expired document, and run_agent steps a real, enabled agent
    // (shape validation alone can't know either).
    const parsedDefinition = parseAiFlowDefinition(body.definition);
    const documentIssues = await validateShareDocumentSteps(body.businessId, parsedDefinition);
    const agentIssues = await validateRunAgentSteps(body.businessId, parsedDefinition);
    const bindingIssues = [...documentIssues, ...agentIssues];
    if (bindingIssues.length > 0) {
      return errorResponse("VALIDATION_ERROR", bindingIssues.join("; "));
    }
    const row = await createAiFlow({
      businessId: body.businessId,
      name: body.name,
      enabled: body.enabled,
      definition: body.definition,
      createdBy: user.userId ?? null
    });
    return successResponse(row, 201);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      return errorResponse("VALIDATION_ERROR", `${err.message}: ${err.issues.join("; ")}`);
    }
    return handleRouteError(err);
  }
}
