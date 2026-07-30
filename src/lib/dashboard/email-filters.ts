import type { ListEmailLogFilters } from "@/lib/db/email-log";

export type EmailsViewFilter =
  | "all"
  | "sent"
  | "received"
  | "inbox"
  | "archived"
  | "unread";

const VIEWS = new Set<EmailsViewFilter>([
  "all",
  "sent",
  "received",
  "inbox",
  "archived",
  "unread"
]);

export function parseEmailsViewFilter(raw: unknown): EmailsViewFilter {
  if (typeof raw === "string" && VIEWS.has(raw as EmailsViewFilter)) {
    return raw as EmailsViewFilter;
  }
  return "all";
}

/**
 * Map Dashboard → Emails filter chips / query params onto listEmailLog options
 * so the server page loads the matching slice (not just client-side filtering
 * of the newest 100 rows).
 */
export function emailListFiltersFromView(input: {
  view: EmailsViewFilter;
  folder?: string;
  label?: string;
  limit?: number;
}): ListEmailLogFilters {
  const folder = (input.folder ?? "").trim();
  const label = (input.label ?? "").trim();
  const filters: ListEmailLogFilters = {
    limit: input.limit ?? 100
  };
  if (label) filters.label = label;

  if (folder) {
    // A concrete folder wins over the Inbox (folder-null) view.
    filters.folder = folder;
    if (input.view === "sent") filters.direction = "outbound";
    else if (input.view === "received" || input.view === "inbox") {
      filters.direction = "inbound";
    } else if (input.view === "archived") {
      filters.inbox = false;
    } else if (input.view === "unread") {
      filters.unreadOnly = true;
    }
    return filters;
  }

  switch (input.view) {
    case "sent":
      filters.direction = "outbound";
      break;
    case "received":
      filters.direction = "inbound";
      break;
    case "inbox":
      filters.inbox = true;
      break;
    case "archived":
      filters.inbox = false;
      break;
    case "unread":
      filters.unreadOnly = true;
      break;
    default:
      break;
  }
  return filters;
}
