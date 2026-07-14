/**
 * Owner-facing: save the structured Business profile (address, industry,
 * per-day hours) for the signed-in account's active business.
 *
 * After the column write, the canonical `business_configs.profile_md`
 * block is re-rendered and the vault sync is kicked fire-and-forget so the
 * live agent (SMS/chat instructions + knowledge lookup) reflects the new
 * facts without a redeploy.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { updateBusinessProfileFields } from "@/lib/db/businesses";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import {
  BUSINESS_HOURS_DAYS,
  isValidHoursTime,
  parseBusinessHours,
  type BusinessHours
} from "@/lib/business-profile/profile";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

const timeSchema = z
  .string()
  .refine(isValidHoursTime, "Times must be 24h HH:MM (e.g. 09:00)");

const daySchema = z.union([z.null(), z.object({ open: timeSchema, close: timeSchema })]);

const schema = z.object({
  address: z.string().trim().max(300, "Address is too long").optional(),
  // "" clears the stored industry. Any other value is accepted: a known
  // slug from BUSINESS_TYPE_LABELS or a free-text custom industry (the
  // onboarding "Other" flow stores the user's own words raw), capped so
  // arbitrary payloads can't bloat the column / prompt.
  businessType: z.string().trim().max(120, "Industry is too long").optional(),
  hours: z
    .object({
      mon: daySchema.optional(),
      tue: daySchema.optional(),
      wed: daySchema.optional(),
      thu: daySchema.optional(),
      fri: daySchema.optional(),
      sat: daySchema.optional(),
      sun: daySchema.optional()
    })
    .optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: this route resolves the business from the
    // SIGNED-IN user's email, so an impersonating admin's write would land
    // on the wrong business. Refuse instead (see isViewAsActive).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = schema.parse(await request.json());

    const db = await createSupabaseServiceClient();
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
    const { data: biz } = await db
      .from("businesses")
      .select("id, business_hours")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");
    const businessId = (biz as { id: string }).id;

    // Merge submitted days OVER the stored value (zod has already validated
    // shapes). A payload carrying only some weekdays must not silently drop
    // the previously saved schedule for the others — omitting a day means
    // "unchanged", an explicit null means "closed".
    let hours: BusinessHours | undefined;
    if (body.hours !== undefined) {
      hours =
        parseBusinessHours((biz as { business_hours?: unknown }).business_hours ?? null) ?? {};
      for (const day of BUSINESS_HOURS_DAYS) {
        const entry = body.hours[day];
        if (entry !== undefined) hours[day] = entry;
      }
    }

    await updateBusinessProfileFields(
      businessId,
      {
        ...(body.address !== undefined ? { address: body.address || null } : {}),
        ...(body.businessType !== undefined
          ? { business_type: body.businessType || null }
          : {}),
        ...(hours !== undefined ? { business_hours: hours as Record<string, unknown> } : {})
      },
      db
    );

    // Best-effort after the committed column write: a refresh failure logs
    // and returns null instead of failing the save the user already made.
    const profileMd = await refreshBusinessProfileMdAndLog(businessId, db);
    // Fire-and-forget: the Supabase write is canonical; a slow/unreachable
    // VPS must not block the settings save (see sync-vault module header).
    void syncVaultToVpsAndLog(businessId);

    return successResponse({ profileMd });
  } catch (err) {
    return handleRouteError(err);
  }
}
