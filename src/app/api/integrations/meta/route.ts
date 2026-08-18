/**
 * Owner-facing management for the business's DIRECT Meta (Facebook) Lead
 * Ads connection (mirrors /api/integrations/calendly).
 *
 *   GET    ?businessId=…      → connection state (masked) + the Page picker
 *                               options while the connection is pending
 *   POST   {businessId, pageId} → finish setup: store the page token,
 *                               subscribe the Page to leadgen, activate
 *   PATCH  {businessId, isActive} → soft-disable / re-enable
 *   PATCH  {businessId, datasetId} → set/clear the Conversions API dataset
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
  setMetaConnectionActive,
  setMetaConnectionDataset
} from "@/lib/db/meta-connections";
import {
  getLinkedInstagramAccount,
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

/**
 * Exactly one of `isActive` (soft-disable/re-enable) or `datasetId` (the
 * owner-entered Conversions API dataset, "" clearing it) per call, so a
 * single PATCH can never half-apply two unrelated intents.
 */
const patchSchema = z
  .object({
    businessId: z.string().uuid(),
    isActive: z.boolean().optional(),
    // Meta dataset (pixel) ids are numeric strings; reject anything else
    // rather than storing a value every upload would 400 on.
    datasetId: z.union([z.string().regex(/^\d{1,32}$/), z.literal("")]).optional()
  })
  .refine(
    (b) => (b.isActive === undefined) !== (b.datasetId === undefined),
    "Provide exactly one of isActive or datasetId"
  );

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

    // A Page routes webhooks to exactly ONE tenant (uq_meta_connections_page).
    // Without this check the activation below hits that unique index and the
    // owner is told "An unexpected error occurred", with no hint that the
    // Page is simply spoken for. Checked BEFORE the subscribe so a refused
    // pick never leaves a Meta-side subscription behind either.
    const existingClaim = await getMetaPageClaim(page.id);
    if (existingClaim && existingClaim.business_id !== body.businessId) {
      // Deliberately NAMELESS. uq_meta_connections_page is global, so the
      // holder can be an unrelated customer who merely shares a Facebook Page
      // admin with this caller; naming them would disclose another tenant's
      // business name, and that they use the product, to anyone holding Page
      // admin (Bugbot ddcefed0). We do not reveal one business to another,
      // and that rule does not bend for the case where the caller happens to
      // own both: the API cannot tell those apart cheaply enough to be worth
      // the risk. An operator who needs to know can see it in the admin
      // tools, or by looking at the Page in Facebook.
      return errorResponse(
        "VALIDATION_ERROR",
        `"${page.name}" is already connected to another business. A Facebook Page can send its leads to one business at a time, disconnect it there first, then pick it here.`
      );
    }

    // Subscribe FIRST: if Meta refuses, the connection stays pending and
    // the owner can retry — we never store an unsubscribed "active" row.
    await subscribePageToLeadgen(page.id, page.accessToken);

    // Linked IG professional account (best-effort — pages without one, or
    // tokens missing the instagram scopes, simply skip Instagram DMs).
    const instagram = await getLinkedInstagramAccount(page.accessToken, page.id);

    // Conversions API dataset: owner-entered, never derived (see the note
    // in src/lib/meta/client.ts). Carried across a reconnect that re-picks
    // the SAME Page so a working feedback loop survives reconnecting;
    // switching Pages drops it, because a dataset belongs to one Page.
    const datasetId = connection.page_id === page.id ? connection.dataset_id : null;

    let row;
    try {
      row = await activateMetaConnection({
        businessId: body.businessId,
        pageId: page.id,
        pageName: page.name,
        pageToken: page.accessToken,
        instagramAccountId: instagram?.id ?? null,
        instagramUsername: instagram?.username ?? null,
        datasetId
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

    if (body.datasetId !== undefined) {
      const row = await setMetaConnectionDataset(
        body.businessId,
        body.datasetId === "" ? null : body.datasetId
      );
      if (!row) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Pick the Page that runs your lead ads first, a dataset attaches to a connected Page"
        );
      }
      return successResponse(row);
    }

    const row = await setMetaConnectionActive(body.businessId, body.isActive!);
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
