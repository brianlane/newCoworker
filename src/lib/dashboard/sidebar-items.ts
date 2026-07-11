/**
 * Canonical owner-dashboard nav catalog (keys, labels, hrefs) shared by the
 * sidebar component (which adds icons client-side), the per-user
 * customization prefs (src/lib/dashboard/sidebar-prefs.ts), and the Settings
 * editor. Keys are the stable identifiers stored in `user_sidebar_items` —
 * renaming a key orphans saved layouts, so treat them as append-only.
 */

export type SidebarItemDef = {
  key: string;
  label: string;
  href: string;
  /**
   * Locked items can't be hidden or moved below the fold accidentally —
   * Settings must always be reachable (it hosts the customizer itself) and
   * Notifications carries the unread badge.
   */
  locked?: boolean;
};

export const SIDEBAR_ITEMS: SidebarItemDef[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard" },
  { key: "analytics", label: "Analytics", href: "/dashboard/analytics" },
  { key: "chat", label: "Chat", href: "/dashboard/chat" },
  { key: "calls", label: "Calls", href: "/dashboard/calls" },
  { key: "messages", label: "Texts", href: "/dashboard/messages" },
  { key: "webchat", label: "Web chat", href: "/dashboard/webchat" },
  { key: "emails", label: "Emails", href: "/dashboard/emails" },
  { key: "customers", label: "Contacts", href: "/dashboard/customers" },
  { key: "employees", label: "Employees", href: "/dashboard/employees" },
  { key: "memory", label: "Memory", href: "/dashboard/memory" },
  { key: "import-export", label: "Import / Export", href: "/dashboard/import-export" },
  { key: "integrations", label: "Integrations", href: "/dashboard/integrations" },
  { key: "aiflows", label: "AiFlows", href: "/dashboard/aiflows" },
  { key: "billing", label: "Billing", href: "/dashboard/billing" },
  { key: "settings", label: "Settings", href: "/dashboard/settings", locked: true },
  { key: "notifications", label: "Notifications", href: "/dashboard/notifications", locked: true }
];
