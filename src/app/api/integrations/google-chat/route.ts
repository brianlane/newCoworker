/**
 * Google Chat connection management for the owner.
 *
 * GET     current state
 * PATCH   pause / resume, or mint a connect code
 * DELETE  disconnect and forget the bindings
 *
 * NO POST, which is the difference from every other card and is deliberate.
 * There is nothing for the owner to paste: a Google Chat space name is
 * opaque and is shown nowhere in the Chat UI, so the connection cannot be
 * created from this side at all. It is created by the inbound handler when
 * a connect code is redeemed IN the space, which is the only moment both
 * halves are known at once.
 *
 * So the card's whole job is minting that code. There is no OAuth redirect
 * and no per-tenant secret either: the app authenticates with our own Google
 * service account, exactly as Teams uses our Azure app.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteCoworkerConnection,
  getPublicCoworkerConnection,
  setCoworkerConnectionActive
} from "@/lib/db/coworker-connections";
import { createLinkCode, deleteChannelIdentities } from "@/lib/db/coworker-identities";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
      connection: await getPublicCoworkerConnection(businessId, "google_chat"),
      allowedForTier: await coworkerChannelAllowedForBusiness(businessId)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Sign in required", 401);

    // The tier gate lives on the MINT rather than on a connect step, because
    // minting is what leads to a connection here. Checking it only at
    // delivery would let a Starter tenant complete the whole setup and hear
    // nothing, with no explanation anywhere.
    if (body.mintLinkCodeFor && !(await coworkerChannelAllowedForBusiness(body.businessId))) {
      return errorResponse(
        "FORBIDDEN",
        "The Google Chat integration is available on Standard and Enterprise plans.",
        403
      );
    }

    if (body.isActive !== undefined) {
      await setCoworkerConnectionActive(body.businessId, "google_chat", body.isActive);
    }
    let linkCode: { code: string; expiresAt: string } | null = null;
    if (body.mintLinkCodeFor) {
      linkCode = await createLinkCode({
        businessId: body.businessId,
        channel: "google_chat",
        employeeId: body.mintLinkCodeFor.employeeId,
        isOwner: body.mintLinkCodeFor.isOwner,
        createdByUserId: user.userId ?? null
      });
    }
    return successResponse({
      connection: await getPublicCoworkerConnection(body.businessId, "google_chat"),
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
    await deleteChannelIdentities(businessId, "google_chat");
    await deleteCoworkerConnection(businessId, "google_chat");
    return successResponse({ disconnected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
