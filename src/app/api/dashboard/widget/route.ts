/**
 * Owner-facing website-chat-widget settings.
 *
 * GET  ?businessId=            → settings row (minted on first read outside
 *      view-as) + tier-allowed flag.
 * POST { businessId, ... }     → update enable/origins/contact-form/theme,
 *      or rotate the site key. manage_settings + Standard+ gated
 *      server-side; view-as is read-only and refused on writes (same
 *      posture as the branding route).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getOrCreateWidgetSettings,
  getWidgetSettingsForBusiness,
  regenerateWidgetKey,
  updateWidgetSettings,
  type ChatWidgetSettingsRow,
  type WidgetSettingsPatch
} from "@/lib/webchat/db";
import {
  normalizeAllowedOrigins,
  parseWidgetTheme,
  widgetThemeSchema
} from "@/lib/webchat/settings-schema";
import {
  WEBCHAT_TIER_MESSAGE,
  WebchatTierValidationError,
  assertWebchatAllowed,
  webchatAllowedForTier
} from "@/lib/webchat/tier-gate";
import { getBusiness } from "@/lib/db/businesses";

export const dynamic = "force-dynamic";

function serializeSettings(row: ChatWidgetSettingsRow) {
  return {
    enabled: row.enabled,
    publicKey: row.public_key,
    allowedOrigins: row.allowed_origins ?? [],
    requireContactForm: row.require_contact_form,
    theme: parseWidgetTheme(row.theme)
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const businessId = z.string().uuid().parse(url.searchParams.get("businessId") ?? "");
    await requireBusinessRole(businessId, "manage_settings");

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    const tierAllowed = webchatAllowedForTier(business.tier);

    // View-as stays read-only — no settings row is minted as a page-load
    // side effect (same rationale as the mailbox card). A missing row just
    // renders the not-yet-set-up state.
    const user = await getAuthUser();
    const viewAs = await isViewAsActive(user);
    const settings =
      viewAs || !tierAllowed
        ? await getWidgetSettingsForBusiness(businessId)
        : await getOrCreateWidgetSettings(businessId);

    return successResponse({
      tierAllowed,
      settings: settings ? serializeSettings(settings) : null
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid query");
    }
    return handleRouteError(err);
  }
}

const postSchema = z.object({
  businessId: z.string().uuid(),
  enabled: z.boolean().optional(),
  allowedOrigins: z.array(z.string().max(300)).max(50).optional(),
  requireContactForm: z.boolean().optional(),
  theme: widgetThemeSchema.nullable().optional(),
  regenerateKey: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    const body = postSchema.parse(await request.json());
    await requireBusinessRole(body.businessId, "manage_settings");
    const user = await getAuthUser();
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }

    // Tier gate on every write except a pure disable — a downgraded tenant
    // can always turn the widget off / shed config, never turn it on.
    const isPureDisable =
      body.enabled === false &&
      body.allowedOrigins === undefined &&
      body.requireContactForm === undefined &&
      body.theme === undefined &&
      !body.regenerateKey;
    if (!isPureDisable) {
      await assertWebchatAllowed(body.businessId);
    }

    // Ensure the row exists (mints the first site key).
    await getOrCreateWidgetSettings(body.businessId);

    if (body.regenerateKey) {
      const rotated = await regenerateWidgetKey(body.businessId);
      return successResponse({ settings: serializeSettings(rotated) });
    }

    const patch: WidgetSettingsPatch = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.requireContactForm !== undefined) {
      patch.require_contact_form = body.requireContactForm;
    }
    if (body.allowedOrigins !== undefined) {
      try {
        patch.allowed_origins = normalizeAllowedOrigins(body.allowedOrigins);
      } catch (err) {
        return errorResponse(
          "VALIDATION_ERROR",
          err instanceof Error ? err.message : "Invalid origins"
        );
      }
    }
    if (body.theme !== undefined) {
      patch.theme =
        body.theme && Object.keys(body.theme).length > 0 ? body.theme : null;
    }
    if (Object.keys(patch).length === 0) {
      return errorResponse("VALIDATION_ERROR", "Nothing to update");
    }

    const updated = await updateWidgetSettings(body.businessId, patch);
    return successResponse({ settings: serializeSettings(updated) });
  } catch (err) {
    if (err instanceof WebchatTierValidationError) {
      return errorResponse("FORBIDDEN", WEBCHAT_TIER_MESSAGE, 403);
    }
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
