/**
 * Per-surface staff mode: when the OWNER or a roster team member reaches
 * the coworker on a channel customers also use, does the coworker answer
 * them as staff?
 *
 * SMS has had this since 20260701000000_staff_sms_mode.sql. Every other
 * surface had nothing, and on WhatsApp that meant the owner messaging their
 * own business number reached the CUSTOMER assistant, was pitched, and was
 * filed as a lead.
 *
 * WHAT THE FLAG MEANS. ON: answer them as staff. OFF: do not answer them on
 * this surface at all. It is never "answer them as a customer". That is the
 * behavior this exists to remove, and it is also exactly what the SMS flag
 * has always meant: off makes the assistant silent, it does not turn the
 * owner into a lead.
 *
 * FAIL DIRECTION. A missing row and a failed read both resolve to ENABLED,
 * the same posture getAgentToolStates takes for tool toggles: a transient
 * database blip must not flip behavior away from what the owner configured.
 * That is safe here precisely because the dangerous mistake, treating a
 * stranger as staff, is decided by resolveSurfaceSpeaker, which fails the
 * other way.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { OWNER_SURFACES, ownerSurfaceByKey, type OwnerSurfaceKey } from "./registry";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Effective state when the owner has never touched this surface. */
export const STAFF_MODE_DEFAULT = true;

/**
 * Reject a surface the registry does not know. A typo would otherwise read
 * a row nothing ever writes, and look like a working default forever.
 */
function assertSurface(surfaceKey: OwnerSurfaceKey): void {
  if (!ownerSurfaceByKey(surfaceKey)) {
    throw new Error(`staff mode: ${surfaceKey} is not a registered coworker surface`);
  }
}

export async function staffModeEnabled(
  businessId: string,
  surfaceKey: OwnerSurfaceKey,
  client?: SupabaseClient
): Promise<boolean> {
  assertSurface(surfaceKey);
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("coworker_staff_mode")
      .select("assistant_reply_enabled")
      .eq("business_id", businessId)
      .eq("surface_key", surfaceKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const enabled = (data as { assistant_reply_enabled?: unknown } | null)
      ?.assistant_reply_enabled;
    return typeof enabled === "boolean" ? enabled : STAFF_MODE_DEFAULT;
  } catch (err) {
    logger.warn("staff mode: read failed; using the default", {
      businessId,
      surfaceKey,
      error: err instanceof Error ? err.message : String(err)
    });
    return STAFF_MODE_DEFAULT;
  }
}

/**
 * Every registered surface's effective state, in one query. What the
 * Settings page renders.
 */
export async function listStaffModes(
  businessId: string,
  client?: SupabaseClient
): Promise<Record<OwnerSurfaceKey, boolean>> {
  const modes = Object.fromEntries(
    OWNER_SURFACES.map((s) => [s.key, STAFF_MODE_DEFAULT])
  ) as Record<OwnerSurfaceKey, boolean>;
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("coworker_staff_mode")
      .select("surface_key, assistant_reply_enabled")
      .eq("business_id", businessId);
    if (error) throw new Error(error.message);
    for (const row of (data as Array<{
      surface_key?: unknown;
      assistant_reply_enabled?: unknown;
    }> | null) ?? []) {
      const key = row.surface_key as OwnerSurfaceKey;
      // A stored row for a surface the registry no longer has must not
      // invent an entry the UI would then render a switch for.
      if (!ownerSurfaceByKey(key)) continue;
      if (typeof row.assistant_reply_enabled === "boolean") {
        modes[key] = row.assistant_reply_enabled;
      }
    }
  } catch (err) {
    logger.warn("staff mode: list failed; using defaults", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return modes;
}

/**
 * Store one surface's flag. Throws on failure rather than reporting a save
 * that did not happen: the dashboard toggle rolls back on a rejection, and
 * swallowing the error would leave the switch showing a state the database
 * does not hold.
 */
export async function setStaffMode(
  businessId: string,
  surfaceKey: OwnerSurfaceKey,
  enabled: boolean,
  client?: SupabaseClient
): Promise<boolean> {
  assertSurface(surfaceKey);
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_staff_mode")
    .upsert(
      {
        business_id: businessId,
        surface_key: surfaceKey,
        assistant_reply_enabled: enabled,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,surface_key" }
    )
    .select("assistant_reply_enabled")
    .single();
  if (error) throw new Error(`setStaffMode: ${error.message}`);
  return (data as { assistant_reply_enabled: boolean }).assistant_reply_enabled;
}
