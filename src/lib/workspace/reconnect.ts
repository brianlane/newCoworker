/**
 * Which existing row a first-party connect should RECONNECT rather than duplicate.
 *
 * This is the hinge of the whole Nango-to-first-party migration, and it has two
 * opposite failure modes, both bad:
 *
 *  - MISS a reconnect and we insert a second row. The flows keep pointing at
 *    the stale one and every later run dies at send time with
 *    `connection_not_found`, the KYP Ads Jul 22 2026 incident class.
 *  - INVENT a reconnect and we re-point an existing row id at a DIFFERENT
 *    mailbox. Flows bound to the first mailbox silently start sending from the
 *    second. That is worse: a duplicate is recoverable, sending a tenant's mail
 *    from the wrong account is not.
 *
 * So this module's rule is: never guess. Decide from the account email when the
 * row carries one, decide from a live identity probe when it does not, and fall
 * back to inserting a new row when neither can settle it.
 *
 * ## Why unlabeled rows exist at all
 *
 * `/api/integrations/nango/complete` only writes
 * `metadata.provider_account_email` when the identity probe SUCCEEDS
 * (`if (Object.keys(identityMetadata).length > 0)`), and rows created before
 * that probe existed were labeled with the dashboard login instead, which is
 * why `debug/backfill-nango-account-identity.ts` had to be written. Unlabeled
 * Outlook rows are a real, existing shape belonging to precisely the tenants a
 * migration most needs to carry across.
 *
 * ## The one case that is decided without a probe
 *
 * A business whose cap is a single connection, holding a single row for this
 * provider,
 * cannot have a second mailbox: the cap forbids it. So the row can only be the
 * one being reconnected. That is not a guess, it is forced.
 *
 * It also has to be handled, or those tenants dead-end: they cannot add
 * (the cap refuses) and often cannot remove either, because the delete guard
 * `flowsReferencingWorkspaceConnection` refuses while a flow still binds the
 * row. Without this branch a Starter tenant with a dead grant is stuck forever.
 */
import type { WorkspaceOAuthConnectionRow } from "@/lib/db/workspace-oauth-connections";

/** The provider key an Outlook mailbox uses, on BOTH transports. */
export const OUTLOOK_KEY = "outlook";

/**
 * Provider keys that mean "this provider", for matching purposes.
 *
 * Outlook has exactly one. Google has FOUR, because the Nango era accumulated
 * `google` (the broad Gmail + Calendar integration), `gmail` and `google-mail`
 * (mail only) and `google-calendar` (calendar only). A reconnect has to consider
 * all of them or a tenant on a legacy key gets a duplicate row and the
 * `connection_not_found` failure this module exists to prevent.
 *
 * Live production holds only `google`, but the resolvers still honour the other
 * three, so matching must too.
 */
export const OUTLOOK_KEYS = [OUTLOOK_KEY] as const;
export const GOOGLE_KEYS = ["google", "gmail", "google-mail", "google-calendar"] as const;

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

export type ReconnectDecision =
  /** Flip this row in place. `matchedBy` records how we knew, for the log. */
  | {
      kind: "reconnect";
      row: WorkspaceOAuthConnectionRow;
      matchedBy: "account_email" | "cap_forces_single_mailbox";
    }
  /**
   * An unlabeled row that MIGHT be this account. The caller must probe the
   * row's live grant and compare before touching it; see
   * `resolveUnlabeledReconnect`.
   */
  | { kind: "verify"; row: WorkspaceOAuthConnectionRow }
  /** A genuinely new mailbox: insert. */
  | { kind: "new" };

/**
 * Decide from the rows alone, escalating to a probe when they cannot settle it.
 *
 * `capMax` is the business's workspace-connection limit (null = unlimited), and
 * is what makes the single-seat case decidable without a network call.
 */
export function findReconnectTarget(
  rows: readonly WorkspaceOAuthConnectionRow[],
  accountEmail: string,
  capMax: number | null,
  providerKeys: readonly string[]
): ReconnectDecision {
  const wanted = accountEmail.trim().toLowerCase();
  if (wanted.length === 0) return { kind: "new" };

  const providerRows = rows.filter((r) => providerKeys.includes(r.provider_config_key));
  if (providerRows.length === 0) return { kind: "new" };

  // 1. The row says who it is. Oldest wins: that is the row flows have had
  //    longest to bind to.
  const labeled = oldestFirst(providerRows.filter((r) => accountEmailOf(r) === wanted));
  if (labeled.length > 0) return { kind: "reconnect", row: labeled[0], matchedBy: "account_email" };

  const soleUnlabeled =
    providerRows.length === 1 && accountEmailOf(providerRows[0]) === null ? providerRows[0] : null;
  if (!soleUnlabeled) return { kind: "new" };

  // 2. One seat, one row: a second mailbox is impossible, so this is it.
  if (capMax === 1 && rows.length === 1) {
    return { kind: "reconnect", row: soleUnlabeled, matchedBy: "cap_forces_single_mailbox" };
  }

  // 3. Room for more than one mailbox and no label to go on. Whether this is a
  //    reconnect or a genuine second mailbox is unknowable from the row, so ask
  //    the provider rather than guessing.
  return { kind: "verify", row: soleUnlabeled };
}

/**
 * Settle a `verify` decision against the unlabeled row's REAL account.
 *
 * `probedEmail` is what the existing row's own grant reports (null when the
 * probe failed, which is common precisely because a dead grant is often WHY
 * someone is reconnecting).
 *
 * A failed probe deliberately resolves to "new". The tenant gets a duplicate
 * row they can clean up, which is recoverable; adopting on a failed probe could
 * re-point a live flow at a different mailbox, which is not.
 */
export function resolveUnlabeledReconnect(
  row: WorkspaceOAuthConnectionRow,
  probedEmail: string | null,
  accountEmail: string
): ReconnectDecision {
  if (!probedEmail) return { kind: "new" };
  const same = probedEmail.trim().toLowerCase() === accountEmail.trim().toLowerCase();
  return same ? { kind: "reconnect", row, matchedBy: "account_email" } : { kind: "new" };
}

/**
 * After inserting a new row, find an OLDER row for the same account that a
 * concurrent connect created.
 *
 * The identity probe runs before the insert, so two callbacks for the same
 * mailbox can both see no existing row and both insert. The window is small but
 * real (two tabs, one mailbox), and the result is duplicate rows with split
 * bindings and an ambiguous resolver. The loser deletes its own row.
 *
 * Returns null when the freshly inserted row is the oldest for that account,
 * which is the common case and means there is nothing to consolidate.
 */
export function findDuplicateRow(
  rows: readonly WorkspaceOAuthConnectionRow[],
  insertedRowId: string,
  accountEmail: string,
  providerKeys: readonly string[]
): WorkspaceOAuthConnectionRow | null {
  const wanted = accountEmail.trim().toLowerCase();
  if (wanted.length === 0) return null;

  const sameAccount = oldestFirst(
    rows.filter(
      (r) => providerKeys.includes(r.provider_config_key) && accountEmailOf(r) === wanted
    )
  );
  if (sameAccount.length < 2) return null;

  const keeper = sameAccount[0];
  // Only the row that lost the race backs out. If ours IS the oldest, the other
  // caller will find us and back out itself.
  return keeper.id === insertedRowId ? null : keeper;
}
