import type { EmailLogSource, ListEmailLogFilters } from "@/lib/db/email-log";
import { AI_MAILBOX_KEY, mailboxSources } from "@/lib/dashboard/email-mailbox";

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
 * Inbox means folder-null. A concrete folder query cannot stay on Inbox without
 * the client filter emptying the list, so coerce to Received.
 */
export function coerceEmailsViewFilter(
  view: EmailsViewFilter,
  folder: string
): EmailsViewFilter {
  if (folder.trim() && view === "inbox") return "received";
  return view;
}

/**
 * Reconcile the view/folder chips with the selected mailbox.
 *
 * Inbox, Archived, Unread and folders are organize state the AI mailbox alone
 * carries (nothing writes `folder`/`archived_at`/`is_read` for a connected
 * Gmail row), so holding one of them while picking a connected mailbox would
 * ask for rows that cannot exist and render an empty page. Widen the view to
 * the nearest thing that still means something instead: Inbox keeps "inbound
 * only", Archived and Unread have no counterpart and fall back to All.
 */
export function coerceEmailsFiltersForMailbox(input: {
  view: EmailsViewFilter;
  folder: string;
  mailbox: string;
}): { view: EmailsViewFilter; folder: string } {
  const connected = Boolean(input.mailbox) && input.mailbox !== AI_MAILBOX_KEY;
  if (!connected) return { view: input.view, folder: input.folder };
  if (input.view === "inbox") return { view: "received", folder: "" };
  if (input.view === "archived" || input.view === "unread") {
    return { view: "all", folder: "" };
  }
  return { view: input.view, folder: "" };
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
  /** "" = every mailbox; AI_MAILBOX_KEY or a connection id narrows the fetch. */
  mailbox?: string;
}): ListEmailLogFilters {
  const folder = (input.folder ?? "").trim();
  const label = (input.label ?? "").trim();
  const filters: ListEmailLogFilters = {
    limit: input.limit ?? 100,
    // Platform alert mail is logged (so its delivery receipt has a home) but
    // is not correspondence: this page is the coworker's mail with customers,
    // and burying that under "Urgent: new lead" alerts would make it useless.
    // Applied to every view, including the source-pinned ones, where it is
    // simply redundant.
    excludeSources: ["notification"]
  };
  if (label) filters.label = label;

  // The mailbox chip is its own source set; where a view also pins sources,
  // keep only what both allow so the two filters compose instead of one
  // silently winning.
  const mailboxOnly = mailboxSources((input.mailbox ?? "").trim());
  // An empty intersection would read as "no source filter" downstream (the
  // query only applies a non-empty array), which would WIDEN the fetch to
  // every mailbox. Fall back to the mailbox's own set instead: still strictly
  // narrower than no filter, and the view's other predicates do the rest.
  const narrow = (base: EmailLogSource[]): EmailLogSource[] => {
    if (!mailboxOnly) return base;
    const both = base.filter((s) => mailboxOnly.includes(s));
    return both.length > 0 ? both : mailboxOnly;
  };

  const aiMailboxSources: EmailLogSource[] = [
    "tenant_mailbox_inbound",
    "tenant_mailbox_outbound"
  ];

  if (folder) {
    // Folders only exist on the AI mailbox; keep the fetch aligned.
    filters.folder = folder;
    filters.sources = narrow(aiMailboxSources);
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
      // Inbox organize view is AI-mailbox-only (same as Unread).
      filters.inbox = true;
      filters.sources = narrow(aiMailboxSources);
      break;
    case "archived":
      filters.inbox = false;
      filters.sources = narrow(aiMailboxSources);
      break;
    case "unread":
      // Unread styling/actions are AI-mailbox-only; keep the fetch aligned.
      filters.unreadOnly = true;
      filters.sources = narrow(aiMailboxSources);
      break;
    default:
      break;
  }
  // Views that pin no sources of their own still honour the mailbox chip.
  if (mailboxOnly && !filters.sources) filters.sources = mailboxOnly;
  return filters;
}

/**
 * Merge the row a deep link named into the list the page fetched.
 *
 * The Emails page lists only the newest 100 rows and the reading pane resolves
 * its selection against that array, so an SMS alert link tapped days later, or
 * on a busy mailbox, would open the page to nothing. The linked row is fetched
 * separately and prepended here when the list query missed it, whether that is
 * because of age or because the active view filters out its source.
 *
 * Never duplicates: a row already in the list is left exactly where it is, so
 * the ordering the query chose is preserved and React keys stay unique.
 */
export function withLinkedEmailRow<T extends { id: string }>(
  rows: T[],
  linked: T | null | undefined
): T[] {
  if (!linked) return rows;
  return rows.some((r) => r.id === linked.id) ? rows : [linked, ...rows];
}

/**
 * Is the Emails list narrowed to a subset right now?
 *
 * Lives here rather than inline in EmailsList because two separate decisions
 * read it and they must not drift: whether to RENDER the filter controls, and
 * whether an empty list means "no mail at all" or "no mail matching this".
 *
 * The controls used to be gated on the row count alone, which is a dead end. A
 * filter combination with no results hid the very buttons needed to leave it,
 * so the only way out was editing the URL. `?view=inbox&mailbox=ai` reached
 * that state on a live account: Inbox is an AI-mailbox-only view, and that
 * mailbox was empty while the connected Gmail had plenty.
 *
 * Deliberately NOT counting the search box. That is client-side text matching
 * over already-loaded rows, it has its own visible input to clear, and folding
 * it in here would make a typed query keep the filter chips alive on a business
 * that has no email at all, which is the one case the chips should stay hidden.
 */
export function emailsFiltersActive(input: {
  view: EmailsViewFilter;
  folder?: string;
  label?: string;
  mailbox?: string;
}): boolean {
  return Boolean(
    input.view !== "all" ||
      (input.folder ?? "").trim() ||
      (input.label ?? "").trim() ||
      (input.mailbox ?? "").trim()
  );
}
