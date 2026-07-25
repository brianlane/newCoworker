import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { upsertBusinessTelnyxSettings } from "@/lib/db/telnyx-routes";
import { GEMINI_LIVE_VOICES } from "@/lib/plans/enterprise-models";
import { normalizeE164 } from "@/lib/telnyx/assign-did";

/**
 * Admin-only: tweak per-tenant Telnyx feature flags without touching the DID
 * assignment. Used by the AssignDidPanel "warm transfer" and "SMS fallback"
 * toggles. All fields are optional so the UI can send partial patches.
 */
const schema = z.object({
  businessId: z.string().uuid(),
  forwardToE164: z
    .union([z.string().min(0).max(25), z.null()])
    .optional(),
  transferEnabled: z.boolean().optional(),
  smsFallbackEnabled: z.boolean().optional(),
  bridgeStaleAlertMuted: z.boolean().optional(),
  translatorModeEnabled: z.boolean().optional(),
  /**
   * Gemini Live voice for this tenant. Empty string or null clears back to the
   * platform default; any other value must be a known prebuilt voice, so a typo
   * cannot reach Gemini and silently break audio on every call.
   */
  voiceName: z
    .union([z.enum(GEMINI_LIVE_VOICES), z.literal(""), z.null()])
    .optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    let normalizedForward: string | null | undefined;
    if (body.forwardToE164 === undefined) {
      normalizedForward = undefined;
    } else if (body.forwardToE164 === null || body.forwardToE164.trim().length === 0) {
      normalizedForward = null;
    } else {
      try {
        normalizedForward = normalizeE164(body.forwardToE164);
      } catch (err) {
        return errorResponse(
          "VALIDATION_ERROR",
          err instanceof Error ? err.message : "Invalid forwardToE164"
        );
      }
    }

    // Translator mode is INDEPENDENT of warm transfer. It used to be coerced to
    // false whenever transfer was off, on the theory that arming
    // `target_legs=both` for a tenant who cannot transfer was misleading state.
    // Now that arming is the default and proven inert without a second leg, that
    // coupling only fought the schema default and silently opted tenants out of a
    // default-on feature. Interpreting is self-gating at runtime: it needs a
    // transfer (or a staff request) to engage at all.
    //
    // Empty string means "back to the platform default" voice, which is a NULL
    // column rather than an empty voice name (Gemini would reject that).
    const voiceName =
      body.voiceName === undefined ? undefined : body.voiceName === "" ? null : body.voiceName;


    const settings = await upsertBusinessTelnyxSettings({
      businessId: body.businessId,
      forwardToE164: normalizedForward,
      transferEnabled: body.transferEnabled,
      smsFallbackEnabled: body.smsFallbackEnabled,
      bridgeStaleAlertMuted: body.bridgeStaleAlertMuted,
      translatorModeEnabled: body.translatorModeEnabled,
      voiceName
    });
    return successResponse({ settings });
  } catch (err) {
    return handleRouteError(err);
  }
}
