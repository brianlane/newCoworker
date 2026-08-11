/**
 * Which existing row a Microsoft connect should RECONNECT rather than duplicate.
 *
 * This is the hinge of the whole Nango-to-first-party migration. Get it right
 * and an owner clicking "Connect Outlook" silently moves their existing
 * connection across transports, keeping the row id that AiFlow mailbox
 * bindings, email triggers and the shared-calendar id all reference. Get it
 * wrong and we insert a SECOND row: the flows keep pointing at the stale one,
 * and every later run dies at send time with `connection_not_found`, which is
 * the KYP Ads Jul 22 2026 incident class.
 *
 * ## Why matching on the account email alone is not enough
 *
 * The obvious rule is "same provider account email". It is right whenever the
 * row carries one, but plenty of rows do not:
 * `/api/integrations/nango/complete` only writes
 * `metadata.provider_account_email` when the identity probe SUCCEEDS
 * (`if (Object.keys(identityMetadata).length > 0)`), and rows created before
 * that probe existed were labeled with the dashboard login instead, which is
 * exactly why `debug/backfill-nango-account-identity.ts` had to be written.
 *
 * So an unlabeled Nango Outlook row is a real, existing shape, and it belongs
 * to precisely the tenants a migration most needs to carry across.
 *
 * ## The rule
 *
 * 1. Prefer an exact, case-insensitive match on `provider_account_email`, and
 *    take the OLDEST such row, since that is the one flows have had longest to
 *    bind to.
 * 2. Failing that, adopt an unlabeled row ONLY when it is the business's sole
 *    Outlook row. Then there is nothing to be ambiguous about: the business has
 *    exactly one Outlook connection and is reconnecting it.
 *
 * Deliberately NOT adopting an unlabeled row when other Outlook rows exist.
 * With two mailboxes and one label missing, "which one did they just connect"
 * is a guess, and guessing wrong re-points a live flow at a different mailbox,
 * which is worse than the duplicate it would avoid.
 */
import type { WorkspaceOAuthConnectionRow } from "@/lib/db/workspace-oauth-connections";

/** The provider key an Outlook mailbox uses, on BOTH transports. */
export const OUTLOOK_KEY = "outlook";

function accountEmailOf(row: WorkspaceOAuthConnectionRow): string | null {
  const value = row.metadata?.provider_account_email;
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

function oldestFirst(
  rows: readonly WorkspaceOAuthConnectionRow[]
): WorkspaceOAuthConnectionRow[] {
  return [...rows].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id)
  );
}

export type ReconnectTarget = {
  row: WorkspaceOAuthConnectionRow;
  /** How we decided, for the log: an unlabeled adoption deserves a trail. */
  matchedBy: "account_email" | "sole_unlabeled_row";
};

/**
 * The row to flip in place, or null when this is a genuinely new mailbox.
 * See the module doc for why rule 2 exists and why it is bounded.
 */
export function findOutlookReconnectTarget(
  rows: readonly WorkspaceOAuthConnectionRow[],
  accountEmail: string
): ReconnectTarget | null {
  const wanted = accountEmail.trim().toLowerCase();
  if (wanted.length === 0) return null;

  const outlookRows = rows.filter((r) => r.provider_config_key === OUTLOOK_KEY);
  if (outlookRows.length === 0) return null;

  const labeled = oldestFirst(outlookRows.filter((r) => accountEmailOf(r) === wanted));
  if (labeled.length > 0) return { row: labeled[0], matchedBy: "account_email" };

  // Rule 2: a lone Outlook row with no identity on it. The business has one
  // Outlook connection, so a reconnect can only mean that one.
  if (outlookRows.length === 1 && accountEmailOf(outlookRows[0]) === null) {
    return { row: outlookRows[0], matchedBy: "sole_unlabeled_row" };
  }

  return null;
}

/**
 * After inserting a new row, find an OLDER row for the same account that a
 * concurrent connect created.
 *
 * The identity probe runs before the insert, so two callbacks for the same
 * mailbox can both see no existing row and both insert. The window is small
 * but real (two tabs, one mailbox), and the result is duplicate rows with
 * split bindings and an ambiguous resolver. The loser deletes its own row.
 *
 * Returns null when the freshly inserted row is the oldest for that account,
 * which is the common case and means there is nothing to consolidate.
 */
export function findDuplicateOutlookRow(
  rows: readonly WorkspaceOAuthConnectionRow[],
  insertedRowId: string,
  accountEmail: string
): WorkspaceOAuthConnectionRow | null {
  const wanted = accountEmail.trim().toLowerCase();
  if (wanted.length === 0) return null;

  const sameAccount = oldestFirst(
    rows.filter((r) => r.provider_config_key === OUTLOOK_KEY && accountEmailOf(r) === wanted)
  );
  if (sameAccount.length < 2) return null;

  const keeper = sameAccount[0];
  // Only the row that lost the race backs out. If ours IS the oldest, the other
  // caller will find us and back out itself.
  return keeper.id === insertedRowId ? null : keeper;
}
