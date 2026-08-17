/**
 * Human-readable labels for `contacts.last_channel`.
 *
 * The stored values are machine identifiers shared with the DB CHECK
 * constraint, the CSV export, and the MCP read tool, so they stay snake_case
 * there. The dashboard renders them to owners, where `booking_page` reads as
 * a leaked column value. This module is the one place that translates.
 *
 * The map is a TOTAL Record rather than a Partial: adding a channel to
 * CustomerMemoryChannel without giving it a label is a compile error here,
 * so a new surface can never reach the UI as raw snake_case.
 */

import type { CustomerMemoryChannel } from "@/lib/customer-memory/types";

export const CHANNEL_DISPLAY_LABELS: Record<CustomerMemoryChannel, string> = {
  sms: "sms",
  voice: "voice",
  dashboard: "dashboard",
  email: "email",
  webchat: "webchat",
  messenger: "messenger",
  whatsapp: "whatsapp",
  booking_page: "booking page"
};

/**
 * Label for a stored channel value, or null when there is no channel (a
 * contact who has never interacted). Unknown values are not dropped: a row
 * written by a newer deploy than the one rendering it still reads sensibly,
 * with underscores spaced out rather than shown raw.
 */
export function contactChannelLabel(
  channel: string | null | undefined
): string | null {
  const raw = channel?.trim();
  if (!raw) return null;
  return CHANNEL_DISPLAY_LABELS[raw as CustomerMemoryChannel] ?? raw.replace(/_/g, " ");
}
