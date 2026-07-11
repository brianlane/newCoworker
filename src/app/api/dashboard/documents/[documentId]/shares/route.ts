/**
 * Business Documents — share-link management for one document.
 *
 *   GET  /api/dashboard/documents/:documentId/shares?businessId=… → list
 *   POST /api/dashboard/documents/:documentId/shares              → revoke
 *        body: { businessId, shareId }
 *
 * Links themselves are minted by the agent tools / AiFlow step; the
 * dashboard only inspects and revokes them.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { listDocumentShares, revokeDocumentShare } from "@/lib/documents/db";

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

    const shares = await listDocumentShares(businessId.data, documentId);
    return successResponse({ shares });
  } catch (err) {
    return handleRouteError(err);
  }
}

const revokeSchema = z.object({
  businessId: z.string().uuid(),
  shareId: z.string().uuid()
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
    const body = revokeSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    // Scoped to the document in the URL: a shareId belonging to a different
    // document is a 404, never a cross-document revoke.
    const revoked = await revokeDocumentShare(body.data.businessId, body.data.shareId, documentId);
    if (revoked === 0) return errorResponse("NOT_FOUND", "Share link not found", 404);
    return successResponse({ revoked: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
