/**
 * Admin: deletion/refund impact preview for a business — the same counts
 * the self-serve delete flow shows owners (contacts, transcripts, messages,
 * flows, DID, VPS), surfaced in the admin confirm dialogs before
 * force-cancel / force-refund execute.
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAccountDeletionImpact } from "@/lib/account/deletion";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const parsed = z.string().uuid().safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) return errorResponse("VALIDATION_ERROR", "businessId is required");

    const impact = await getAccountDeletionImpact(parsed.data);
    if (!impact) return errorResponse("NOT_FOUND", "Business not found", 404);
    return successResponse({ impact });
  } catch (err) {
    return handleRouteError(err);
  }
}
