/**
 * Business Documents — signature requests for one document.
 *
 *   GET   /api/dashboard/documents/:documentId/signature-requests?businessId=…  → list
 *   POST  …/signature-requests                                                  → create + deliver
 *         body: { businessId, signerName, phone? | email?, message? }
 *   PATCH …/signature-requests                                                  → void an unsigned request
 *         body: { businessId, requestId }
 *
 * Creation goes through the same core the dashboard coworker tool uses
 * (requestDocumentSignatureTool), so delivery, opt-out checks, and the
 * void-on-failed-send guarantee are identical on both paths. Signed
 * requests are immutable evidence — void only works before signing.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getBusinessDocument,
  listDocumentSignatureRequests,
  voidSignatureRequest
} from "@/lib/documents/db";
import { requestDocumentSignatureTool } from "@/lib/documents/tool-handlers";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "view_dashboard");

    const requests = await listDocumentSignatureRequests(businessId.data, documentId);
    return successResponse({ requests });
  } catch (err) {
    return handleRouteError(err);
  }
}

const createSchema = z
  .object({
    businessId: z.string().uuid(),
    signerName: z.string().min(1).max(200),
    phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164").optional(),
    email: z.string().email().optional(),
    message: z.string().max(1000).optional()
  })
  .refine((v) => v.phone || v.email, {
    message: "Provide the signer's phone or email"
  });

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const body = createSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const document = await getBusinessDocument(body.data.businessId, documentId);
    if (!document) return errorResponse("NOT_FOUND", "Document not found", 404);

    const result = await requestDocumentSignatureTool(
      body.data.businessId,
      {
        documentRef: documentId,
        signerName: body.data.signerName,
        ...(body.data.phone ? { phone: body.data.phone } : {}),
        ...(body.data.email ? { email: body.data.email } : {}),
        ...(body.data.message ? { message: body.data.message } : {})
      },
      "dashboard"
    );
    if (!result.ok) {
      return errorResponse("VALIDATION_ERROR", result.message ?? result.detail ?? "Request failed");
    }
    return successResponse(result.data, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}

const voidSchema = z.object({
  businessId: z.string().uuid(),
  requestId: z.string().uuid()
});

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const body = voidSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    // Scoped to the document in the URL; signed requests never void.
    const voided = await voidSignatureRequest(body.data.businessId, body.data.requestId, documentId);
    if (voided === 0) {
      return errorResponse("NOT_FOUND", "No voidable signature request found", 404);
    }
    return successResponse({ voided: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
