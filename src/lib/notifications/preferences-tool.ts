/**
 * AI-surface notification toggle core: the update_notification_preferences
 * tool shared by dashboard chat (inline), the texting coworker (Rowboat),
 * and the Claude connector (MCP).
 *
 * Born from KYP (Jul 20 2026): James texted "You need to let me know when
 * clients text back", the AI promised alerts, and no tool could flip
 * `customer_reply_alerts`, so the promise was empty until an operator one-shot.
 *
 * Security posture, identical on every surface:
 *   - BOOLEAN TOGGLES ONLY, whitelisted below. Recipients (`phone_number`,
 *     `alert_email`, digest overrides) and `unsubscribed_at` are untouchable:
 *     a hijacked alert destination is the scarier failure than a flipped
 *     boolean, and unsubscribe is a human-consent action.
 *   - `enableOnly` (the SMS surface): the texting coworker serves customers
 *     and staff with the SAME agent, so a prompt-injected customer could
 *     reach this tool. Enable-only makes the worst outcome extra noise;
 *     alerts can never be SILENCED from a text conversation (quieting
 *     toggles, where "on" means less email, are refused entirely there).
 *     Turning things off requires the dashboard (or MCP/dashboard-chat,
 *     where the caller's manage_settings role is verified).
 *
 * Delegates to updateNotificationPreferences so re-enabling a channel also
 * clears `unsubscribed_at`, byte-identical to the settings page. Never
 * throws; tool arms return the refusal to the model instead.
 */
import {
  updateNotificationPreferences,
  type NotificationPreferencesRow,
  type NotificationPreferencesUpdate
} from "@/lib/db/notification-preferences";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** The complete set of AI-mutable notification toggles. */
export const NOTIFICATION_TOGGLE_KEYS = [
  "customer_reply_alerts",
  "aiflow_failure_alerts",
  "unassigned_booking_alerts",
  "sms_urgent",
  "whatsapp_urgent",
  "email_urgent",
  "email_digest",
  "email_digest_weekly",
  "digest_customer_facing_only",
  "dashboard_alerts",
  "sms_warm_transfer",
  "image_limit_alerts",
  "category_leads",
  "category_team",
  "category_system"
] as const;

export type NotificationToggleKey = (typeof NOTIFICATION_TOGGLE_KEYS)[number];

/**
 * Toggles where ENABLING reduces what the owner hears (quieting toggles).
 * The `enableOnly` SMS surface exists so a prompt-injected customer can at
 * worst create extra noise; for these keys "on" means LESS email, so the
 * texting surface may not touch them in either direction.
 */
export const QUIETING_TOGGLE_KEYS: ReadonlySet<NotificationToggleKey> = new Set([
  "digest_customer_facing_only"
]);

export type NotificationToggleMap = Record<NotificationToggleKey, boolean>;

export type NotificationToggleResult =
  | {
      ok: true;
      data: {
        /** Exactly what this call changed. */
        updated: Partial<NotificationToggleMap>;
        /** The resulting full toggle state, for an honest confirmation. */
        settings: NotificationToggleMap;
      };
    }
  | { ok: false; detail: string; message?: string };

/** The toggle-only projection of a preferences row (no recipients, no PII). */
export function notificationToggleMap(row: NotificationPreferencesRow): NotificationToggleMap {
  const map = {} as NotificationToggleMap;
  for (const key of NOTIFICATION_TOGGLE_KEYS) {
    map[key] = Boolean(row[key] ?? false);
  }
  return map;
}

/**
 * Validate and apply a set of whitelisted boolean toggles. Never throws.
 */
export async function applyNotificationPreferenceToggles(
  businessId: string,
  rawToggles: Record<string, unknown>,
  opts: { enableOnly?: boolean } = {},
  client?: SupabaseClient
): Promise<NotificationToggleResult> {
  const allowed = new Set<string>(NOTIFICATION_TOGGLE_KEYS);
  const patch: Partial<NotificationToggleMap> = {};
  for (const [key, value] of Object.entries(rawToggles)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) {
      return {
        ok: false,
        detail: `unknown_toggle:${key}`,
        message:
          `"${key}" is not a notification toggle. The only settings this tool can change: ` +
          `${NOTIFICATION_TOGGLE_KEYS.join(", ")}. Alert phone/email and unsubscribe are ` +
          "changed from Dashboard → Settings → Notifications only."
      };
    }
    if (typeof value !== "boolean") {
      return {
        ok: false,
        detail: `invalid_value:${key}`,
        message: `"${key}" takes true or false.`
      };
    }
    patch[key as NotificationToggleKey] = value;
  }

  const entries = Object.entries(patch) as Array<[NotificationToggleKey, boolean]>;
  if (entries.length === 0) {
    return {
      ok: false,
      detail: "no_toggles",
      message: `Pass at least one toggle (true/false): ${NOTIFICATION_TOGGLE_KEYS.join(", ")}.`
    };
  }

  if (
    opts.enableOnly &&
    entries.some(([key, value]) => value === false || QUIETING_TOGGLE_KEYS.has(key))
  ) {
    return {
      ok: false,
      detail: "enable_only_surface",
      message:
        "Over text you can only turn alerts ON. Turning alerts off (or changing anything " +
        "else) is done from the dashboard: Settings → Notifications. Tell them so."
    };
  }

  try {
    const row = await updateNotificationPreferences(
      businessId,
      patch as NotificationPreferencesUpdate,
      client
    );
    return { ok: true, data: { updated: patch, settings: notificationToggleMap(row) } };
  } catch (err) {
    logger.warn("notification preferences tool: update failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      detail: "update_failed",
      message:
        "The settings write failed: nothing was changed. Tell them to try again or use " +
        "Dashboard → Settings → Notifications."
    };
  }
}
