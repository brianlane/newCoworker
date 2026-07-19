/**
 * Canonical owner-dashboard nav catalog (keys, labelKeys, hrefs) shared by the
 * sidebar component (which adds icons client-side), the per-user
 * customization prefs (src/lib/dashboard/sidebar-prefs.ts), and the Settings
 * editor. Keys are the stable identifiers stored in `user_sidebar_items` —
 * renaming a key orphans saved layouts, so treat them as append-only.
 */

export type SidebarItemDef = {
  key: string;
  /** i18n key under dashboard.nav */
  labelKey: string;
  href: string;
  locked?: boolean;
  requiresMetaConnection?: boolean;
  requiresWhatsAppConnection?: boolean;
};

export const SIDEBAR_ITEMS: SidebarItemDef[] = [
  { key: "dashboard", labelKey: "dashboard", href: "/dashboard" },
  { key: "tasks", labelKey: "tasks", href: "/dashboard/tasks" },
  { key: "analytics", labelKey: "analytics", href: "/dashboard/analytics" },
  { key: "chat", labelKey: "chat", href: "/dashboard/chat" },
  { key: "calls", labelKey: "calls", href: "/dashboard/calls" },
  { key: "messages", labelKey: "messages", href: "/dashboard/messages" },
  {
    key: "messenger",
    labelKey: "messenger",
    href: "/dashboard/messenger",
    requiresMetaConnection: true
  },
  {
    key: "whatsapp",
    labelKey: "whatsapp",
    href: "/dashboard/whatsapp",
    requiresWhatsAppConnection: true
  },
  { key: "aiflows", labelKey: "aiflows", href: "/dashboard/aiflows" },
  { key: "agents", labelKey: "agents", href: "/dashboard/agents" },
  { key: "webchat", labelKey: "webchat", href: "/dashboard/webchat" },
  { key: "emails", labelKey: "emails", href: "/dashboard/emails" },
  { key: "customers", labelKey: "customers", href: "/dashboard/customers" },
  { key: "employees", labelKey: "employees", href: "/dashboard/employees" },
  { key: "memory", labelKey: "memory", href: "/dashboard/memory" },
  { key: "documents", labelKey: "documents", href: "/dashboard/documents" },
  { key: "marketing", labelKey: "marketing", href: "/dashboard/marketing" },
  { key: "import-export", labelKey: "importExport", href: "/dashboard/import-export" },
  { key: "integrations", labelKey: "integrations", href: "/dashboard/integrations" },
  { key: "billing", labelKey: "billing", href: "/dashboard/billing" },
  { key: "settings", labelKey: "settings", href: "/dashboard/settings", locked: true },
  { key: "notifications", labelKey: "notifications", href: "/dashboard/notifications", locked: true }
];

export function filterSidebarItemsForBusiness<T extends SidebarItemDef>(
  items: T[],
  flags: { metaConnected: boolean; whatsappConnected?: boolean }
): T[] {
  return items.filter(
    (item) =>
      (!item.requiresMetaConnection || flags.metaConnected) &&
      (!item.requiresWhatsAppConnection || flags.whatsappConnected === true)
  );
}
