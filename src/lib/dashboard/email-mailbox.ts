/**
 * Which mailbox physically carried a row on the dashboard Emails page.
 *
 * Two different mailboxes feed `email_log`, and until now the page mixed them:
 *
 *   - the AI coworker's own mailbox (`@newcoworker.com`), which the tenant
 *     mailbox poller and the flow `send_email` step read and write, and
 *   - the owner's CONNECTED Gmail/Outlook, which the flow's owner-mailbox
 *     sends, the email-trigger poller, the assistant surfaces (chat / SMS /
 *     voice / Slack), the email coworker, booking reminders, and a by-hand
 *     dashboard send from a connected sender all go through.
 *
 * `email_log` has no connection column, so attribution is derived here:
 * `source` decides WHICH SIDE a row is on (that mapping is exact, since every
 * writer picks its transport before it picks its source), and the row's own
 * address decides WHICH connected mailbox when the owner has more than one.
 *
 * Pure and dependency-light on purpose: the server page uses it to narrow the
 * query, and the client list uses it to filter the rows already loaded.
 */

import type { EmailLogSource } from "@/lib/db/email-log";
import { extractEmailAddress, extractEmailAddresses } from "@/lib/email/address";

/** Chip value for the AI coworker mailbox. Never a connection id (a uuid). */
export const AI_MAILBOX_KEY = "ai";

/**
 * Rows that rode the AI coworker's own mailbox. `ai_flow` is here because it
 * is a platform (Resend) send on the coworker's behalf: it never touches the
 * owner's connected mailbox, which is the distinction this filter draws.
 */
export const AI_MAILBOX_SOURCES: EmailLogSource[] = [
  "tenant_mailbox_inbound",
  "tenant_mailbox_outbound",
  "ai_flow"
];

/** Rows that rode one of the owner's connected Gmail/Outlook mailboxes. */
export const CONNECTED_MAILBOX_SOURCES: EmailLogSource[] = [
  "owner_mailbox",
  "email_trigger",
  "dashboard_chat",
  "sms_assistant",
  "voice_assistant",
  "slack_assistant",
  "owner_manual",
  "email_coworker",
  "booking_reminder"
];

/** A selectable mailbox: the coworker's, or one connected account. */
export type MailboxOption = {
  /** AI_MAILBOX_KEY, or a workspace_oauth_connections.id. */
  id: string;
  /** Chip text: the address when known, else the provider name. */
  label: string;
  /** The mailbox address, lowercase, when known. */
  email: string | null;
};

/** The subset of a row this module reads (keeps tests free of full rows). */
export type MailboxRow = {
  direction: "inbound" | "outbound";
  source: EmailLogSource;
  from_email: string | null;
  to_email: string | null;
};

/**
 * Build the mailbox chips from the composer's "send from" options. The first
 * option (id "") is always the coworker mailbox; the rest are connections.
 *
 * Returns [] when nothing is connected: with one mailbox there is nothing to
 * filter BETWEEN, so the page hides the row entirely rather than showing a
 * lone chip that can only ever be a no-op.
 */
export function mailboxOptionsFromSendFrom(
  sendFrom: { id: string; label: string; email: string | null }[]
): MailboxOption[] {
  const connected = sendFrom.filter((o) => o.id !== "");
  if (connected.length === 0) return [];
  const coworker = sendFrom.find((o) => o.id === "");
  const out: MailboxOption[] = [
    {
      id: AI_MAILBOX_KEY,
      label: "AI Mailbox",
      email: extractEmailAddress(coworker?.email ?? null)
    }
  ];
  for (const c of connected) {
    const email = extractEmailAddress(c.email);
    out.push({ id: c.id, label: email ?? c.label, email });
  }
  return out;
}

/** "" (all mailboxes) unless `raw` names one of the built chips. */
export function parseMailboxFilter(raw: unknown, options: MailboxOption[]): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  return options.some((o) => o.id === value) ? value : "";
}

/**
 * The addresses this row was delivered to / sent from on OUR side: the sender
 * for outbound, every To recipient for inbound (an inbound header can name
 * several, only one of which is ours).
 */
function ourAddresses(row: MailboxRow): string[] {
  if (row.direction === "outbound") {
    const from = extractEmailAddress(row.from_email);
    return from ? [from] : [];
  }
  return extractEmailAddresses(row.to_email);
}

/**
 * Does this row belong to the selected mailbox?
 *
 * The AI chip is pure source. A connected chip is source AND address, with one
 * deliberate fallback: when exactly one mailbox is connected, a connected-side
 * row whose address we cannot read (missing connection metadata, an alias, a
 * legacy row) still counts as that mailbox's. There is nowhere else it could
 * have come from, and dropping it would hide real mail behind a filter.
 */
export function rowMatchesMailbox(
  row: MailboxRow,
  mailbox: string,
  options: MailboxOption[]
): boolean {
  if (!mailbox) return true;
  const isAiRow = AI_MAILBOX_SOURCES.includes(row.source);
  if (mailbox === AI_MAILBOX_KEY) return isAiRow;
  if (isAiRow) return false;
  const target = options.find((o) => o.id === mailbox);
  if (!target) return false;
  const addresses = ourAddresses(row);
  if (target.email && addresses.includes(target.email)) return true;
  // Sole connected mailbox: nothing else could have carried the row, so an
  // address we cannot match still lands here rather than nowhere.
  return options.filter((o) => o.id !== AI_MAILBOX_KEY).length === 1;
}

/**
 * `email_log.source` values worth fetching for this chip. Both sides are exact
 * source sets, so this narrows the SERVER query too, instead of leaving the
 * mailbox split to a client filter over the newest 100 rows.
 */
export function mailboxSources(mailbox: string): EmailLogSource[] | null {
  if (!mailbox) return null;
  return mailbox === AI_MAILBOX_KEY ? AI_MAILBOX_SOURCES : CONNECTED_MAILBOX_SOURCES;
}
