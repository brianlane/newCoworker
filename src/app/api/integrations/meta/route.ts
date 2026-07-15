/**
 * Owner-facing management for the business's DIRECT Meta (Facebook) Lead
 * Ads connection (mirrors /api/integrations/calendly).
 *
 *   GET    ?businessId=…      → connection state (masked) + the Page picker
 *                               options while the connection is pending
 *   POST   {businessId, pageId} → finish setup: store the page token,
 *                               subscribe the Page to leadgen, activate
 *   PATCH  {businessId, isActive} → soft-disable / re-enable
 *   DELETE {businessId}       → best-effort unsubscribe, then remove
 *
 * Auth mirrors the other integration routes: owner/manager session with
 * `manage_settings` on the business (admins bypass).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  activateMetaConnection,
  deleteMetaConnection,
  getMetaConnection,
  getMetaPageClaim,
  getPublicMetaConnection,
  setMetaConnectionActive
} from "@/lib/db/meta-connections";
import {
  listManagedPages,
  subscribePageToLeadgen,
  unsubscribePage
} from "@/lib/meta/client";
import { logger } from "@/lib/logger";

const businessIdSchema = z.string().uuid();

const selectPageSchema = z.object({
  businessId: z.string().uuid(),
  pageId: z.string().min(1).max(64)
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

    const connection = await getPublicMetaConnection(parsed.data);

    // While pending, surface the Page options (ids + names only — the page
    // tokens stay server-side until one is chosen).
    let pages: Array<{ id: string; name: string }> = [];
    if (connection?.status === "pending") {
      const decrypted = await getMetaConnection(parsed.data);
      if (decrypted?.userToken) {
        try {
          pages = (await listManagedPages(decrypted.userToken)).map((p) => ({
            id: p.id,
            name: p.name
          }));
        } catch (err) {
          logger.warn("meta page listing failed", {
            businessId: parsed.data,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    return successResponse({ connection, pages });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = selectPageSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const connection = await getMetaConnection(body.businessId);
    if (!connection?.userToken) {
      return errorResponse(
        "NOT_FOUND",
        "Connect Facebook first - there is no pending connection to finish"
      );
    }

    const pages = await listManagedPages(connection.userToken);
    const page = pages.find((p) => p.id === body.pageId);
    if (!page) {
      return errorResponse(
        "VALIDATION_ERROR",
        "That Page is not available on the connected Facebook account"
      );
    }

    // Subscribe FIRST: if Meta refuses, the connection stays pending and
    // the owner can retry — we never store an unsubscribed "active" row.
    await subscribePageToLeadgen(page.id, page.accessToken);

    let row;
    try {
      row = await activateMetaConnection({
        businessId: body.businessId,
        pageId: page.id,
        pageName: page.name,
        pageToken: page.accessToken
      });
    } catch (err) {
      // Roll the Meta side back (best-effort) so a failed activation never
      // leaves a dangling subscription delivering events no row routes.
      // The subscription is a single platform-app<->page edge shared by
      // whoever holds the Page, so only unsubscribe if no OTHER tenant
      // (active or paused) claims it — otherwise the rollback would sever
      // that tenant's delivery.
      const claim = await getMetaPageClaim(page.id).catch(() => null);
      if (!claim || claim.business_id === body.businessId) {
        await unsubscribePage(page.id, page.accessToken);
      }
      throw err;
    }
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const existing = await getPublicMetaConnection(body.businessId);
    if (!existing) return errorResponse("NOT_FOUND", "No Meta connection");
    const row = await setMetaConnectionActive(body.businessId, body.isActive);
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = z
      .object({ businessId: z.string().uuid() })
      .parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // Best-effort: stop Meta deliveries for the page before dropping the
    // row (unsubscribePage never throws).
    const connection = await getMetaConnection(body.businessId);
    if (connection?.page_id && connection.pageToken) {
      await unsubscribePage(connection.page_id, connection.pageToken);
    }

    await deleteMetaConnection(body.businessId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
