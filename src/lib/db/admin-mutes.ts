/**
 * Per-business admin notification mutes (migration
 * 20260811063723_admin_notification_mutes.sql).
 *
 * Three independent switches on `businesses`, flipped from the admin business
 * page, that hide one business from the fleet-wide feeds on /admin/dashboard:
 *
 *   * admin_mute_activity — "Recent Activity" (coworker_logs)
 *   * admin_mute_errors   — "System Errors: All Clients" (system_logs errors)
 *   * admin_mute_alerts   — "Recent Alerts" (coworker_logs urgent_alert/error)
 *
 * Muting only filters the aggregate admin feeds; rows are still written and
 * stay fully visible on the business's own admin page, and owner-facing
 * notifications are untouched.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type AdminNotificationMutes = {
  muteActivity: boolean;
  muteErrors: boolean;
  muteAlerts: boolean;
};

/** Business ids to exclude from each fleet-wide admin dashboard feed. */
export type AdminMutedBusinessIds = {
  activity: string[];
  errors: string[];
  alerts: string[];
};

/**
 * All businesses with at least one mute enabled, grouped per feed. One small
 * read (only muted rows come back) that the dashboard runs before the feed
 * queries so a muted tenant can't eat the feed row budget.
 */
export async function getAdminMutedBusinessIds(
  client?: SupabaseClient
): Promise<AdminMutedBusinessIds> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("id, admin_mute_activity, admin_mute_errors, admin_mute_alerts")
    .or("admin_mute_activity.eq.true,admin_mute_errors.eq.true,admin_mute_alerts.eq.true");
  if (error) throw new Error(`getAdminMutedBusinessIds: ${error.message}`);
  const rows = (data ?? []) as Array<{
    id: string;
    admin_mute_activity: boolean;
    admin_mute_errors: boolean;
    admin_mute_alerts: boolean;
  }>;
  return {
    activity: rows.filter((r) => r.admin_mute_activity).map((r) => r.id),
    errors: rows.filter((r) => r.admin_mute_errors).map((r) => r.id),
    alerts: rows.filter((r) => r.admin_mute_alerts).map((r) => r.id)
  };
}

/**
 * Patch a business's mute switches. Fields left undefined are unchanged so
 * the UI can send partial patches. Returns the effective state after the
 * update.
 */
export async function setAdminNotificationMutes(
  businessId: string,
  input: Partial<AdminNotificationMutes>,
  client?: SupabaseClient
): Promise<AdminNotificationMutes> {
  const db = client ?? (await createSupabaseServiceClient());
  const row: Record<string, unknown> = {
    ...(input.muteActivity !== undefined ? { admin_mute_activity: input.muteActivity } : {}),
    ...(input.muteErrors !== undefined ? { admin_mute_errors: input.muteErrors } : {}),
    ...(input.muteAlerts !== undefined ? { admin_mute_alerts: input.muteAlerts } : {})
  };
  const { data, error } = await db
    .from("businesses")
    .update(row)
    .eq("id", businessId)
    .select("admin_mute_activity, admin_mute_errors, admin_mute_alerts")
    .single();
  if (error) throw new Error(`setAdminNotificationMutes: ${error.message}`);
  const r = data as {
    admin_mute_activity: boolean;
    admin_mute_errors: boolean;
    admin_mute_alerts: boolean;
  };
  return {
    muteActivity: r.admin_mute_activity,
    muteErrors: r.admin_mute_errors,
    muteAlerts: r.admin_mute_alerts
  };
}
