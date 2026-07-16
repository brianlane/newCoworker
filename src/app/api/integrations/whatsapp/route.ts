/**
 * Owner-facing management for the business's WhatsApp Business connection
 * (Embedded Signup — mirrors /api/integrations/meta).
 *
 *   GET    ?businessId=…  → connection state (masked, incl. template
 *                           review statuses, refreshed opportunistically)
 *   POST   {businessId, code, wabaId, phoneNumberId, displayPhoneNumber?}
 *                         → finish Embedded Signup: exchange the popup's
 *                           code for a business token, subscribe the WABA
 *                           to our webhooks, auto-register the stock
 *                           utility templates, store the connection
 *   PATCH  {businessId, isActive} → soft-disable / re-enable
 *   DELETE {businessId}   → best-effort WABA unsubscribe, then remove
 *
 * Auth mirrors the other integration routes: owner/manager session with
 * `manage_settings` on the business (admins bypass).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteWhatsAppConnection,
  getPublicWhatsAppConnection,
  getWhatsAppConnection,
  getWhatsAppPhoneNumberClaim,
  isWabaClaimedByOtherBusiness,
  saveWhatsAppConnection,
  setWhatsAppConnectionActive,
  updateWhatsAppTemplates,
  type WhatsAppTemplatesState
} from "@/lib/db/whatsapp-connections";
import {
  exchangeEmbeddedSignupCode,
  fetchWhatsAppTemplateStatuses,
  registerWhatsAppTemplates,
  subscribeWabaToApp,
  unsubscribeWabaFromApp
} from "@/lib/meta/client";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

const connectSchema = z.object({
  businessId: z.string().uuid(),
  code: z.string().min(1).max(2048),
  wabaId: z.string().min(1).max(64),
  phoneNumberId: z.string().min(1).max(64),
  displayPhoneNumber: z.string().max(32).optional()
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  isActive: z.boolean()
});

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await authorize(parsed.data);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    let connection = await getPublicWhatsAppConnection(parsed.data);

    // Opportunistic template-status refresh: templates sit in Meta review
    // for minutes to hours after connect; PENDING rows flip to APPROVED
    // the next time the owner looks at the card.
    const hasPending = Object.values(connection?.templates ?? {}).some(
      (t) => t.status !== "APPROVED"
    );
    if (connection && hasPending) {
      try {
        const decrypted = await getWhatsAppConnection(parsed.data);
        if (decrypted?.accessToken) {
          const statuses = await fetchWhatsAppTemplateStatuses(
            decrypted.waba_id,
            decrypted.accessToken
          );
          if (statuses.length > 0) {
            const merged: WhatsAppTemplatesState = { ...(connection.templates ?? {}) };
            for (const s of statuses) {
              merged[s.name] = { status: s.status, language: s.language };
            }
            await updateWhatsAppTemplates(parsed.data, merged);
            connection = { ...connection, templates: merged };
          }
        }
      } catch (err) {
        logger.warn("whatsapp template status refresh failed", {
          businessId: parsed.data,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return successResponse({ connection });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = connectSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // Another tenant already holding this number is a hard conflict — the
    // unique index would reject the insert anyway; fail with a clear
    // message before burning the one-time code.
    const claim = await getWhatsAppPhoneNumberClaim(body.phoneNumberId);
    if (claim && claim.business_id !== body.businessId) {
      return errorResponse(
        "CONFLICT",
        "That WhatsApp number is already connected to another account",
        409
      );
    }

    const accessToken = await exchangeEmbeddedSignupCode(body.code);

    // Subscribe FIRST: if Meta refuses, nothing is stored and the owner
    // can retry the popup — we never store an unsubscribed connection.
    await subscribeWabaToApp(body.wabaId, accessToken);

    // Stock utility templates (owner alerts + out-of-window follow-ups).
    // Registration failures degrade to window-only sends, never block
    // the connect.
    const templateStatuses = await registerWhatsAppTemplates(body.wabaId, accessToken);
    const templates: WhatsAppTemplatesState = {};
    for (const t of templateStatuses) {
      templates[t.name] = { status: t.status, language: t.language };
    }
    // Reconnects: registration answers "already exists" (recorded as
    // PENDING above), but the live review status may long since be
    // APPROVED — fetch it now so out-of-window sends aren't blocked until
    // someone happens to open the integration card. Best-effort.
    try {
      for (const s of await fetchWhatsAppTemplateStatuses(body.wabaId, accessToken)) {
        templates[s.name] = { status: s.status, language: s.language };
      }
    } catch (err) {
      logger.warn("whatsapp connect: template status fetch failed; card refresh will reconcile", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    // Reconnect with a DIFFERENT WABA: capture the abandoned one so its
    // app subscription can be torn down after the new row is saved (the
    // Meta callback's ordering — never unsubscribe before the DB commit,
    // and never a WABA another tenant still routes through).
    const previous = await getWhatsAppConnection(body.businessId).catch(() => null);

    const connection = await saveWhatsAppConnection({
      businessId: body.businessId,
      wabaId: body.wabaId,
      phoneNumberId: body.phoneNumberId,
      displayPhoneNumber: body.displayPhoneNumber ?? null,
      accessToken,
      templates
    });

    if (previous?.accessToken && previous.waba_id !== body.wabaId) {
      const sharedElsewhere = await isWabaClaimedByOtherBusiness(
        previous.waba_id,
        body.businessId
      ).catch(() => true); // fail toward NOT unsubscribing
      if (!sharedElsewhere) {
        // Best-effort (never throws): stray webhook deliveries for the
        // abandoned WABA would be unroutable noise otherwise.
        await unsubscribeWabaFromApp(previous.waba_id, previous.accessToken);
      }
    }

    logger.info("whatsapp connected", {
      businessId: body.businessId,
      wabaId: body.wabaId,
      phoneNumberId: body.phoneNumberId
    });
    return successResponse({ connection });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const connection = await setWhatsAppConnectionActive(body.businessId, body.isActive);
    return successResponse({ connection });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await authorize(parsed.data);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const existing = await getWhatsAppConnection(parsed.data);
    if (existing?.accessToken) {
      // One WABA can back multiple tenants (different phone numbers), and
      // the app subscription is WABA-level — tearing it down while another
      // tenant still routes through it would silence THEIR inbound too.
      const sharedElsewhere = await isWabaClaimedByOtherBusiness(
        existing.waba_id,
        parsed.data
      ).catch(() => true); // fail toward NOT unsubscribing
      if (!sharedElsewhere) {
        // Best-effort: a failed unsubscribe must not strand the owner with
        // an undeletable connection (unsubscribeWabaFromApp never throws).
        await unsubscribeWabaFromApp(existing.waba_id, existing.accessToken);
      }
    }
    await deleteWhatsAppConnection(parsed.data);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
