/**
 * Microsoft Teams connection management for the owner.
 *
 * GET     current state
 * POST    bind this business to an Entra tenant id
 * PATCH   pause / resume, or mint a connect code
 * DELETE  disconnect and forget the bindings
 *
 * NO TOKEN AND NO OAUTH REDIRECT HERE, unlike every other card. Teams
 * authenticates with OUR Azure app credentials, not the tenant's, so there
 * is no per-tenant secret to store. What the owner supplies is which Entra
 * tenant to accept activities from, which is the boundary that stops a
 * multi-tenant bot serving a business it was never given to.
 *
 * The alert target is NOT set here. Teams cannot start a conversation, so
 * there is nowhere to send until somebody messages the bot once; the inbound
 * handler captures that first conversation and its regional service URL.
 * That is why the card says "now message your bot" and why an alert before
 * that reports `no_alert_target` rather than failing.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  CoworkerWorkspaceAlreadyLinkedError,
  deleteCoworkerConnection,
  getPublicCoworkerConnection,
  setCoworkerConnectionActive,
  upsertCoworkerConnection
} from "@/lib/db/coworker-connections";
import { createLinkCode, deleteChannelIdentities } from "@/lib/db/coworker-identities";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Entra tenant ids are GUIDs. */
const TENANT_ID = z.string().trim().uuid();

const connectSchema = z.object({
  businessId: z.string().uuid(),
  tenantId: TENANT_ID
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  isActive: z.boolean().optional(),
  mintLinkCodeFor: z
    .object({ isOwner: z.boolean(), employeeId: z.string().uuid().nullable() })
    .optional()
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
    const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required", 400);
    }
    if (!(await authorize(businessId))) {
      return errorResponse("UNAUTHORIZED", "Sign in required", 401);
    }
    return successResponse({
      connection: await getPublicCoworkerConnection(businessId, "teams"),
      allowedForTier: await coworkerChannelAllowedForBusiness(businessId)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = connectSchema.parse(await request.json());
    if (!(await authorize(body.businessId))) {
      return errorResponse("UNAUTHORIZED", "Sign in required", 401);
    }
    if (!(await coworkerChannelAllowedForBusiness(body.businessId))) {
      return errorResponse(
        "FORBIDDEN",
        "The Microsoft Teams integration is available on Standard and Enterprise plans.",
        403
      );
    }
    const connection = await upsertCoworkerConnection({
      businessId: body.businessId,
      channel: "teams",
      externalWorkspaceId: body.tenantId,
      // No per-tenant secret exists for this channel: the bot authenticates
      // with our own Azure app credentials. The column is NOT NULL so it
      // holds an empty string, which is exactly why the shared "is this
      // connection live" reader checks is_active alone and leaves the
      // credential check to the channels that actually store one.
      credential: ""
    });
    return successResponse({ connection });
  } catch (err) {
    if (err instanceof CoworkerWorkspaceAlreadyLinkedError) {
      return errorResponse("CONFLICT", err.message, 409);
    }
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Sign in required", 401);

    if (body.isActive !== undefined) {
      await setCoworkerConnectionActive(body.businessId, "teams", body.isActive);
    }
    let linkCode: { code: string; expiresAt: string } | null = null;
    if (body.mintLinkCodeFor) {
      linkCode = await createLinkCode({
        businessId: body.businessId,
        channel: "teams",
        employeeId: body.mintLinkCodeFor.employeeId,
        isOwner: body.mintLinkCodeFor.isOwner,
        createdByUserId: user.userId ?? null
      });
    }
    return successResponse({
      connection: await getPublicCoworkerConnection(body.businessId, "teams"),
      linkCode
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required", 400);
    }
    if (!(await authorize(businessId))) {
      return errorResponse("UNAUTHORIZED", "Sign in required", 401);
    }
    // Forget who was connected too: nothing cascades these, so a later
    // reconnect would otherwise treat every previously bound account as
    // staff again.
    await deleteChannelIdentities(businessId, "teams");
    await deleteCoworkerConnection(businessId, "teams");
    return successResponse({ disconnected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
