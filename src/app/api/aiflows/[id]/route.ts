/**
 * Item-level CRUD for a single AiFlow (GET / PATCH / DELETE). Owner-only.
 *
 * PATCH accepts any subset of { name, enabled, definition }; a supplied
 * definition is re-validated by `parseAiFlowDefinition` in the db layer.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deleteAiFlow, getAiFlow, updateAiFlow } from "@/lib/ai-flows/db";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { validateShareDocumentSteps } from "@/lib/ai-flows/document-steps";
import { validateRunAgentSteps } from "@/lib/ai-flows/agent-steps";

const idSchema = z.string().uuid();

const patchSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  definition: z.unknown().optional()
});

const deleteSchema = z.object({ businessId: z.string().uuid() });

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    if (!businessId || !idSchema.safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_aiflows");
    const row = await getAiFlow(businessId, id);
    if (!row) return errorResponse("NOT_FOUND", "AiFlow not found");
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const body = patchSchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");
    if (body.definition !== undefined) {
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
    }
    const row = await updateAiFlow({
      businessId: body.businessId,
      id,
      name: body.name,
      enabled: body.enabled,
      definition: body.definition
    });
    return successResponse(row);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      return errorResponse("VALIDATION_ERROR", `${err.message}: ${err.issues.join("; ")}`);
    }
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const body = deleteSchema.parse(await request.json().catch(() => ({})));
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");
    await deleteAiFlow(body.businessId, id);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
