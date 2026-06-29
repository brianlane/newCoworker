import type { ActivityItem } from "@/lib/db/activity";

/**
 * Badge label + color for each activity kind, shared by the dashboard's Recent
 * Activity card and the full "See all activity" page so the two surfaces tag
 * events identically. Pure data (no "use client") so it can be imported from
 * both the server card and the client list.
 */
export const ACTIVITY_BADGE: Record<
  ActivityItem["kind"],
  { label: string; variant: "online" | "pending" | "neutral" | "success" | "urgent" }
> = {
  call: { label: "Call", variant: "online" },
  sms_inbound: { label: "Text in", variant: "pending" },
  sms_outbound: { label: "Text out", variant: "neutral" },
  chat: { label: "Chat", variant: "neutral" },
  aiflow: { label: "AiFlow", variant: "success" },
  customer: { label: "Customer", variant: "pending" },
  alert: { label: "Alert", variant: "urgent" }
};
