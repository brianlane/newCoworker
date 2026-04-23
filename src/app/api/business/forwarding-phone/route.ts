/**
 * Owner-editable forwarding phone (business_telnyx_settings.forward_to_e164).
 *
 * Safe Mode depends on this being set. If the owner clears the number while
 * Safe Mode is ON, we auto-disable Safe Mode too to avoid a broken state
 * (customer messages would otherwise silently drop).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  E164_REGEX,
  setForwardToE164
} from "@/lib/db/telnyx-routes";
import { setCustomerChannelsEnabled } from "@/lib/db/businesses";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  phone: z.string().max(20)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(body.businessId);

    const trimmed = body.phone.trim();
    const clearing = trimmed.length === 0;

    if (!clearing && !E164_REGEX.test(trimmed)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Use E.164 format (e.g. +15555550123)."
      );
    }

    await setForwardToE164(body.businessId, clearing ? null : trimmed);

    // If we just cleared the number, auto-disable Safe Mode so customer
    // channels fall back to normal AI handling rather than black-holing.
    let safeModeDisabled = false;
    if (clearing) {
      const db = await createSupabaseServiceClient();
      const { data } = await db
        .from("businesses")
        .select("customer_channels_enabled")
        .eq("id", body.businessId)
        .maybeSingle();
      if (data && data.customer_channels_enabled === false) {
        await setCustomerChannelsEnabled(body.businessId, true);
        safeModeDisabled = true;
      }
    }

    return successResponse({
      phone: clearing ? null : trimmed,
      safeModeDisabled
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
