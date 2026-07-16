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
  /**
   * Conditional items only render for businesses with an ACTIVE Meta
   * (Facebook) connection — the dashboard layout computes the flag per
   * request and filters via filterSidebarItemsForBusiness. Saved layouts
   * are additive-keyed, so the item slotting in later (after the owner
   * connects Facebook) never breaks an existing customization.
   */
  requiresMetaConnection?: boolean;
  /** Same conditional mechanism, gated on an ACTIVE WhatsApp connection. */
  requiresWhatsAppConnection?: boolean;
};

export const SIDEBAR_ITEMS: SidebarItemDef[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard" },
  // Staff Task Center: every lead in motion (active workflow + lead state +
  // goals + collected info + response reasoning). Staff-visible.
  { key: "tasks", label: "Tasks", href: "/dashboard/tasks" },
  { key: "analytics", label: "Analytics", href: "/dashboard/analytics" },
  { key: "chat", label: "Chat", href: "/dashboard/chat" },
  { key: "calls", label: "Calls", href: "/dashboard/calls" },
  { key: "messages", label: "Texts", href: "/dashboard/messages" },
  {
    key: "messenger",
    label: "Messenger",
    href: "/dashboard/messenger",
    requiresMetaConnection: true
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    href: "/dashboard/whatsapp",
    requiresWhatsAppConnection: true
  },
  { key: "aiflows", label: "AiFlows", href: "/dashboard/aiflows" },
  { key: "agents", label: "Agents", href: "/dashboard/agents" },
  { key: "webchat", label: "Web chat", href: "/dashboard/webchat" },
  { key: "emails", label: "Emails", href: "/dashboard/emails" },
  { key: "customers", label: "Contacts", href: "/dashboard/customers" },
  { key: "employees", label: "Employees", href: "/dashboard/employees" },
  { key: "memory", label: "Memory", href: "/dashboard/memory" },
  { key: "import-export", label: "Import / Export", href: "/dashboard/import-export" },
  { key: "integrations", label: "Integrations", href: "/dashboard/integrations" },
  { key: "billing", label: "Billing", href: "/dashboard/billing" },
  { key: "settings", label: "Settings", href: "/dashboard/settings", locked: true },
  { key: "notifications", label: "Notifications", href: "/dashboard/notifications", locked: true }
];

/**
 * Drop conditional items the business hasn't unlocked (the Messenger inbox,
 * gated on an active Meta connection; the WhatsApp inbox, gated on an
 * active WhatsApp connection). Applied by the dashboard layout (nav render)
 * AND the Settings sidebar customizer, so a not-yet-connected business
 * never sees the item anywhere.
 */
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
