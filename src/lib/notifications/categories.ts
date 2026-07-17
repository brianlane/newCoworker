/**
 * Notification categories (BizBlasts-style per-event-type preferences).
 *
 * The channel toggles (sms_urgent / email_urgent / dashboard_alerts) say HOW
 * the owner wants to be reached; categories say WHICH events are worth
 * reaching them for. An alert is delivered only when both gates pass.
 * Generic urgent alerts ("general") are deliberately never category-gated —
 * they are the escalation path of last resort.
 */

export type NotificationCategory = "leads" | "team" | "system" | "general";

/** Kind → category. Unknown/future kinds default to the ungated "general". */
export function resolveNotificationCategory(kind: string): NotificationCategory {
  switch (kind) {
    case "voice_capture":
    case "link_click":
      return "leads";
    case "voice_team_notify":
    case "sms_team_notify":
      return "team";
    case "byon_port":
      return "system";
    default:
      return "general";
  }
}

export type CategoryPreferenceFlags = {
  category_leads: boolean;
  category_team: boolean;
  category_system: boolean;
};

/** Whether the owner has this category switched on. "general" always is. */
export function notificationCategoryEnabled(
  category: NotificationCategory,
  prefs: CategoryPreferenceFlags
): boolean {
  switch (category) {
    case "leads":
      return prefs.category_leads;
    case "team":
      return prefs.category_team;
    case "system":
      return prefs.category_system;
    case "general":
      return true;
  }
}
