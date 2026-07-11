/**
 * Owner-facing: update the owner's display name and contact phone on the
 * active business row. The phone also appears in the rendered Business
 * profile block, so the save refreshes `profile_md` + kicks the vault sync.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { updateBusinessProfileFields } from "@/lib/db/businesses";
import { refreshBusinessProfileMd } from "@/lib/business-profile/refresh";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

const schema = z.object({
  ownerName: z.string().trim().max(120, "Name is too long").optional(),
  phone: z
    .string()
    .trim()
    .max(40, "Phone number is too long")
    .refine((v) => v === "" || /^[+()0-9 .\-]+$/.test(v), "Enter a valid phone number")
    .optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only (see /api/account/business-name for rationale).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = schema.parse(await request.json());

    const db = await createSupabaseServiceClient();
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
    const { data: biz } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");
    const businessId = (biz as { id: string }).id;

    if (body.ownerName !== undefined) {
      const { error } = await db
        .from("businesses")
        .update({ owner_name: body.ownerName || null })
        .eq("id", businessId);
      if (error) throw new Error(`owner-profile: ${error.message}`);
    }
    if (body.phone !== undefined) {
      await updateBusinessProfileFields(businessId, { phone: body.phone || null }, db);
    }
    if (body.ownerName !== undefined || body.phone !== undefined) {
      // Both facts appear in the rendered profile block the agent is
      // grounded on — re-render and push so the coworker stops using the
      // old primary-contact name/number immediately.
      await refreshBusinessProfileMd(businessId, db);
      void syncVaultToVpsAndLog(businessId);
    }

    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
