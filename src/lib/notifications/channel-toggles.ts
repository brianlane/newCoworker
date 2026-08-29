import type { NotificationPreferencesUpdate } from "@/lib/db/notification-preferences";

/**
 * Every toggle that turns an owner-alert channel ON, and therefore every
 * toggle "unsubscribe from all" has to clear.
 *
 * Two surfaces spell out that one gesture: the dashboard's "Unsubscribe from
 * all" button, and the unscoped one-click link in the footer of our emails.
 * They kept drifting apart, and the drift hides well, because it is not a
 * delivery bug. `dispatchNotification` suppresses every channel on
 * `unsubscribed_at` alone, so the alert is silenced either way. What leaks is
 * the dashboard, which renders each toggle from its own column: whichever key
 * a surface forgot to clear renders ON underneath the "you unsubscribed"
 * banner, reading as though that channel were still live.
 *
 * It happened to `whatsapp_urgent`, then again to `push_urgent` (#1717), and
 * by the time anyone looked properly the email link was also missing every
 * chat channel added by #1718-#1724 while the dashboard button was missing
 * `email_monthly_recap` (#1727). Both surfaces now build the payload from
 * this array, so the next channel reaches the two of them together or
 * neither.
 *
 * Deliberately NOT here: the four narrowing toggles
 * (`digest_customer_facing_only`, `category_leads`, `category_team`,
 * `category_system`). They filter what an already-on channel delivers rather
 * than turning a channel on, so clearing them quiets nothing, and forcing
 * them false would silently widen what an owner hears the moment they
 * re-subscribe. `whatsapp_replaces_sms` and the `booking_alert_*` fields are
 * out for the same reason: they reroute, they do not enable.
 *
 * `satisfies` pins every entry to a column `updateNotificationPreferences`
 * can actually write, so a typo or a renamed column fails the build instead
 * of becoming a patch field the update loop silently drops.
 *
 * Deliberately NOT exported: `allChannelTogglesOff()` is the only way in, so
 * a caller cannot half-use the list, and the tests assert against what that
 * function actually produces rather than against a second copy of the names.
 */
const CHANNEL_TOGGLE_KEYS = [
  "sms_urgent",
  "whatsapp_urgent",
  "slack_urgent",
  "telegram_urgent",
  "teams_urgent",
  "google_chat_urgent",
  "slack_digest",
  "push_urgent",
  "email_urgent",
  "email_digest",
  "email_digest_weekly",
  "email_monthly_recap",
  "dashboard_alerts",
  "sms_warm_transfer",
  "image_limit_alerts",
  "aiflow_failure_alerts",
  "customer_reply_alerts",
  "unassigned_booking_alerts"
] as const satisfies readonly (keyof NotificationPreferencesUpdate)[];

export type ChannelToggleKey = (typeof CHANNEL_TOGGLE_KEYS)[number];

/**
 * Every channel toggle set to false: the body of "unsubscribe from all".
 *
 * Returns a fresh object each call so a caller can spread `unsubscribed_at`
 * (or anything else) onto it without editing shared state.
 */
export function allChannelTogglesOff(): Record<ChannelToggleKey, false> {
  const off = {} as Record<ChannelToggleKey, false>;
  for (const key of CHANNEL_TOGGLE_KEYS) off[key] = false;
  return off;
}
