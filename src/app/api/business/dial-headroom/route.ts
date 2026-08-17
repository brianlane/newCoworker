/**
 * Owner-editable outbound dial headroom
 * (business_telnyx_settings.voice_outbound_dial_headroom).
 *
 * The tenant's carrier cap (10 concurrent calls on Standard) is shared by
 * AI flow dials, warm transfers of live callers, and reach_teammate rings.
 * This setting is how the owner chooses the consequence at the cap: the AI
 * stops dialing new calls once in-flight calls reach (cap - headroom),
 * holding the remainder for the legs that carry a live human. 0 lets the AI
 * use every line; null resets to the platform default (3).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { upsertBusinessTelnyxSettings } from "@/lib/db/telnyx-routes";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** 0..9 (the DB check constraint's bounds); null resets to the default. */
  headroom: z.number().int().min(0).max(9).nullable()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    const settings = await upsertBusinessTelnyxSettings({
      businessId: body.businessId,
      voiceOutboundDialHeadroom: body.headroom
    });

    return successResponse({ headroom: settings.voice_outbound_dial_headroom });
  } catch (err) {
    return handleRouteError(err);
  }
}
