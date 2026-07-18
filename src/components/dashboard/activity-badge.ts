import type { ActivityItem } from "@/lib/db/activity";

/**
 * Badge label + color for each activity kind, shared by the dashboard's Recent
 * Activity card and the full "See all activity" page so the two surfaces tag
 * events identically. Pure data (no "use client") so it can be imported from
 * both the server card and the client list.
 */
// Key order is meaningful: the activity page's filter chips render in this
// order (AiFlow deliberately first). `label` stays the English text (used
// as the i18n fallback and by non-localized callers); `labelKey` points at
// `dashboard.activityBadge.*` for localized render sites.
export const ACTIVITY_BADGE: Record<
  ActivityItem["kind"],
  {
    label: string;
    labelKey: string;
    variant: "online" | "pending" | "neutral" | "success" | "urgent";
  }
> = {
  aiflow: { label: "AiFlow", labelKey: "aiflow", variant: "success" },
  call: { label: "Call", labelKey: "call", variant: "online" },
  sms_inbound: { label: "Text in", labelKey: "smsInbound", variant: "pending" },
  sms_outbound: { label: "Text out", labelKey: "smsOutbound", variant: "neutral" },
  email_inbound: { label: "Email in", labelKey: "emailInbound", variant: "pending" },
  email_outbound: { label: "Email out", labelKey: "emailOutbound", variant: "neutral" },
  chat: { label: "Chat", labelKey: "chat", variant: "neutral" },
  customer: { label: "Customer", labelKey: "customer", variant: "pending" },
  alert: { label: "Alert", labelKey: "alert", variant: "urgent" }
};
