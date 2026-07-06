/**
 * "Place call" for an OUTBOUND voice AiFlow. Owner-only (admins may act for a
 * tenant). The flow's trigger must be `voice` with `direction: "outbound"` and a
 * single `outbound_call` step.
 *
 * This route only authenticates + validates, then forwards to the
 * telnyx-voice-originate Edge function (service-role bearer). That function
 * dials, reserves voice budget under the real leg id BEFORE any media, and hangs
 * up if the account is over budget — so an over-budget tenant can never place an
 * AI call. The optional `toE164` overrides the step's default callee for a
 * one-off call.
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAiFlow } from "@/lib/ai-flows/db";

const idSchema = z.string().uuid();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  // Optional per-call override; the Edge function normalizes + validates it.
  toE164: z.string().min(3).max(20).optional()
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(body.businessId);

    const flow = await getAiFlow(body.businessId, id);
    if (!flow) return errorResponse("NOT_FOUND", "AiFlow not found");
    if (!flow.enabled) return errorResponse("VALIDATION_ERROR", "Enable the flow before placing a call");

    const trigger = flow.definition?.trigger;
    if (trigger?.channel !== "voice" || trigger?.direction !== "outbound") {
      return errorResponse("VALIDATION_ERROR", "This flow is not an outbound voice flow");
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    // Authenticate to telnyx-voice-originate with the shared INTERNAL_CRON_SECRET
    // (assertCronAuth), NOT the service-role key: the platform-injected
    // service-role key inside the function can differ from this app's copy on
    // projects using the new API-key system, which would 401 every call.
    const cronSecret = process.env.INTERNAL_CRON_SECRET?.trim();
    if (!supabaseUrl || !cronSecret) {
      return errorResponse("INTERNAL_SERVER_ERROR", "Voice origination is not configured");
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/telnyx-voice-originate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        businessId: body.businessId,
        flowId: id,
        ...(body.toE164 ? { toE164: body.toE164 } : {})
      })
    });
    const result = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; reason?: string; callControlId?: string; to?: string }
      | null;

    if (!res.ok || !result?.ok) {
      // Budget refusals come back as 200 { ok:false, reason } from the Edge fn.
      const reason = result?.reason ?? result?.error ?? "place_call_failed";
      const message =
        reason === "quota_exhausted"
          ? "Out of voice minutes for this billing period."
          : reason === "concurrent_limit"
            ? "Too many calls in progress right now; try again shortly."
            : reason === "invalid_callee"
              ? "Enter a valid phone number to call."
              : reason === "no_caller_id" || reason === "no_telnyx_connection"
                ? "This account has no voice number configured to call from."
                : "Could not place the call. Please try again.";
      return errorResponse("VALIDATION_ERROR", message);
    }

    return successResponse({ callControlId: result.callControlId, to: result.to });
  } catch (err) {
    return handleRouteError(err);
  }
}
