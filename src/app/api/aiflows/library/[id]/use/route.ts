/**
 * Duplicate a public library entry into the caller's business.
 *
 * Fills the scrubbed template's placeholders with the owner's own phone / email
 * / first roster member (and, for the review starter, a pasted review URL),
 * creates a DISABLED ai_flows row (so nothing fires until reviewed), records
 * the download, and returns the new flow id. Owner-only and rate-limited
 * (download-count inflation guard).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitDurable } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createAiFlow } from "@/lib/ai-flows/db";
import { AiFlowValidationError } from "@/lib/ai-flows/schema";
import { getAiFlowLibraryEntry, recordLibraryDownload } from "@/lib/ai-flows/library";
import { applyLibrarySubstitutions, isReviewStarterLibraryKey, REVIEW_LINK_PLACEHOLDER } from "@/lib/ai-flows/scrub";
import { cleanReviewLink } from "@/lib/ai-flows/templates";

export const runtime = "nodejs";

const idSchema = z.string().uuid();
const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** Required when the library entry still carries the review-link sentinel. */
  reviewLink: z.string().max(300).optional()
});

// A duplicate creates one flow + one download row; 10/min/business is ample for
// real use and stops scripted download-count inflation.
const USE_RATE_LIMIT = { interval: 60_000, maxRequests: 10 };

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");

    const limiter = await rateLimitDurable(`aiflow-library-use:${body.businessId}`, USE_RATE_LIMIT);
    if (!limiter.success) {
      return errorResponse("FORBIDDEN", "Too many requests; wait a moment and try again.", 429);
    }

    const entry = await getAiFlowLibraryEntry(id);
    if (!entry) return errorResponse("NOT_FOUND", "Library flow not found");

    let reviewLink: string | null = null;
    if (isReviewStarterLibraryKey(entry.template_key)) {
      const cleaned = typeof body.reviewLink === "string" ? cleanReviewLink(body.reviewLink) : null;
      // Refuse the catalog sentinel (and any other example.invalid URL): it
      // passes cleanReviewLink as a real https URL, but installing it would
      // text customers a dead link.
      let refused = !cleaned;
      if (cleaned) {
        try {
          refused =
            cleaned === REVIEW_LINK_PLACEHOLDER ||
            new URL(cleaned).hostname === "example.invalid";
        } catch {
          refused = true;
        }
      }
      if (refused) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Paste a full review link starting with https:// (e.g. your Google review URL)."
        );
      }
      reviewLink = cleaned;
    }

    const db = await createSupabaseServiceClient();
    const [{ data: business }, { data: members }] = await Promise.all([
      db.from("businesses").select("phone").eq("id", body.businessId).maybeSingle(),
      db
        .from("ai_flow_team_members")
        .select("name")
        .eq("business_id", body.businessId)
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(1)
    ]);

    const filled = applyLibrarySubstitutions(entry.scrubbed_definition, {
      ownerPhone: (business?.phone as string | null | undefined) ?? null,
      ownerEmail: user.email,
      employeeName: (members?.[0]?.name as string | undefined) ?? null,
      reviewLink
    });

    let row;
    try {
      row = await createAiFlow({
        businessId: body.businessId,
        name: `${entry.title}`.slice(0, 120),
        enabled: false,
        definition: filled,
        createdBy: user.userId ?? null
      });
    } catch (err) {
      if (err instanceof AiFlowValidationError) {
        // Usually a leftover placeholder (e.g. the business has no phone on
        // file). Surface a clear, fixable message instead of a generic 500.
        return errorResponse(
          "VALIDATION_ERROR",
          `Couldn't adapt this flow automatically: ${err.issues.join("; ")}. Open it in the editor to finish.`
        );
      }
      throw err;
    }

    // Best-effort: a download-log failure must not undo a successful duplicate.
    try {
      await recordLibraryDownload(entry.id, body.businessId, db);
    } catch {
      /* download stats are non-critical */
    }

    return successResponse({ flowId: row.id }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
