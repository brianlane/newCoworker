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
 * A business whose cap is a single connection, holding a single connection
 * row in total (across every provider, which is how the cap itself counts),
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
 * Google has FOUR, because the Nango era accumulated `google` (the broad
 * Gmail + Calendar integration), `gmail` and `google-mail` (mail only) and
 * `google-calendar` (calendar only). A reconnect has to consider all of them
 * or a tenant on a legacy key gets a duplicate row and the
 * `connection_not_found` failure this module exists to prevent. Live
 * production holds only `google`, but the resolvers still honour the other
 * three, so matching must too.
 *
 * Outlook deliberately lists ONE key, even though a legacy `outlook-calendar`
 * key exists and the calendar resolver still honours it. Adopting a
 * calendar-only row on a MAILBOX connect would be wrong, not just useless:
 * the flip preserves provider_config_key, and `outlook-calendar` is not a
 * sendable email key, so the tenant would end "connected" with no mailbox row
 * at all. The dead-end is also recoverable without matching: the delete guard
 * tracks only email-flow references and calendar triggers store no connection
 * id, so a stale calendar-only row can always be removed by hand. So a
 * first-party Outlook connect next to a legacy calendar row correctly inserts
 * a fresh mailbox row and leaves the calendar row alone.
 */
export const OUTLOOK_KEYS = [OUTLOOK_KEY] as const;
export const GOOGLE_KEYS = ["google", "gmail", "google-mail", "google-calendar"] as const;

function accountIdOf(row: WorkspaceOAuthConnectionRow): string | null {
  const value = row.metadata?.provider_account_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function accountEmailOf(row: WorkspaceOAuthConnectionRow): string | null {
  const value = row.metadata?.provider_account_email;
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

/**
 * Every address a row is known by: its label plus any aliases recorded at
 * connect time. Rows written before aliases existed have just the label, which
 * is exactly the legacy case this set exists to match against.
 */
/**
 * Every representation one account answers to, normalized.
 *
 * The single definition on purpose. `findReconnectTarget`,
 * `resolveUnlabeledReconnect`, and `findDuplicateRow` all compare identities,
 * and when only the first was taught about alias sets the others kept
 * comparing one string and quietly reintroduced the duplicate-row bug on
 * their own paths. None of them builds its own set now.
 */
export function identitySet(
  primary: string | null | undefined,
  aliases: readonly string[] = []
): Set<string> {
  return new Set(
    [primary, ...aliases]
      .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
      .filter((v) => v.length > 0)
  );
}

function accountAliasesOf(row: WorkspaceOAuthConnectionRow): string[] {
  const stored = row.metadata?.provider_account_aliases;
  const list = Array.isArray(stored)
    ? stored.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  const label = accountEmailOf(row);
  return [...new Set([...(label ? [label] : []), ...list.map((v) => v.toLowerCase())])];
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
      matchedBy: "account_id" | "account_email" | "cap_forces_single_mailbox";
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
  providerKeys: readonly string[],
  accountId: string | null = null,
  aliases: readonly string[] = []
): ReconnectDecision {
  const wanted = accountEmail.trim().toLowerCase();
  if (wanted.length === 0) return { kind: "new" };

  // Every representation the incoming account answers to. A personal Microsoft
  // account's synthetic outlook_<CID>@outlook.com lives here alongside the real
  // address, which is what lets a row labeled with either one still match.
  const wantedSet = identitySet(wanted, aliases);

  const providerRows = rows.filter((r) => providerKeys.includes(r.provider_config_key));
  if (providerRows.length === 0) return { kind: "new" };

  // A DIFFERENT account id is conclusive, and vetoes everything below.
  //
  // Alias overlap is not proof of sameness: two genuinely distinct accounts can
  // list the same address. A work/school account and a personal Microsoft
  // account can both answer at team@newcoworker.com, the work one via
  // otherMails and the personal one as its primary, while being different
  // mailboxes with different ids. Matching on the shared alias re-pointed a
  // live row at the other mailbox, which is the worst outcome available here:
  // flows keep their binding and silently start sending from an account the
  // owner never chose.
  //
  // So when BOTH sides carry an id and they differ, that row is out. Rows with
  // no id at all stay eligible, which is what keeps the legacy Nango migration
  // working: those rows never got one.
  const candidates = accountId
    ? providerRows.filter((r) => {
        const rowId = accountIdOf(r);
        return rowId === null || rowId === accountId;
      })
    : providerRows;
  if (candidates.length === 0) return { kind: "new" };

  // 1. The provider's own account id, when both sides have one.
  //
  //    Preferred over the email because it is the part of an account's identity
  //    that cannot change representation underneath us, and the email demonstrably
  //    can. A personal Microsoft account first stored as its synthetic
  //    `outlook_<CID>@outlook.com` and later resolved to the owner's real address
  //    is the SAME mailbox; matching on email alone would read that reconnect as a
  //    brand-new account and strand every flow on the old row.
  if (accountId) {
    const byId = oldestFirst(candidates.filter((r) => accountIdOf(r) === accountId));
    if (byId.length > 0) return { kind: "reconnect", row: byId[0], matchedBy: "account_id" };
  }

  // 2. The row says who it is. Compared as SETS, so a row labeled with one
  //    representation of the account still matches a connect that resolved a
  //    different one. Oldest wins: that is the row flows have had longest to
  //    bind to.
  const labeled = oldestFirst(
    candidates.filter((r) => accountAliasesOf(r).some((a) => wantedSet.has(a)))
  );
  if (labeled.length > 0) return { kind: "reconnect", row: labeled[0], matchedBy: "account_email" };

  // Labeled candidates that survive to this point carry no matching identity
  // (a matching id returned at step 1, a matching label or alias at step 2,
  // and a conflicting id was vetoed out entirely), so they identify OTHER
  // accounts, which says nothing about an unlabeled row sitting next to them.
  // They therefore do not suppress the probe; only genuine ambiguity does.
  // With TWO unlabeled rows there is no principled pick, and probing one
  // proves nothing about the other, so that stays "new".
  const unlabeled = candidates.filter((r) => accountEmailOf(r) === null);
  const soleUnlabeled = unlabeled.length === 1 ? unlabeled[0] : null;
  if (!soleUnlabeled) return { kind: "new" };

  // 3. One seat, one row: a second mailbox is impossible, so this is it.
  if (capMax === 1 && rows.length === 1) {
    return { kind: "reconnect", row: soleUnlabeled, matchedBy: "cap_forces_single_mailbox" };
  }

  // 4. Room for more than one mailbox and no label to go on. Whether this is a
  //    reconnect or a genuine second mailbox is unknowable from the row, so ask
  //    the provider rather than guessing.
  return { kind: "verify", row: soleUnlabeled };
}

/**
 * Settle a `verify` decision against the unlabeled row's REAL account.
 *
 * `probedEmail` and `probedAccountId` are what the existing row's own grant
 * reports (null when the probe failed, which is common precisely because a
 * dead grant is often WHY someone is reconnecting). `accountId` is the
 * incoming connect's account id, the same value `findReconnectTarget` takes.
 *
 * When BOTH sides carry an account id, the ids settle it alone, in either
 * direction, exactly as on the labeled path. Equality is conclusive sameness:
 * the email is just a representation and representations drift, so an id
 * match adopts even when the probed spelling is unrecognized (or missing
 * entirely, which Graph permits). A DIFFERENT id is conclusive otherness:
 * two genuinely distinct accounts can both answer at one address (a work
 * account via otherMails, a personal one as its primary), so adopting on the
 * shared address would re-point the row and every flow bound to it at a
 * mailbox the owner never chose. That is the same incident class the labeled
 * path's veto exists for, closed on the probe path too.
 *
 * A failed probe deliberately resolves to "new". The tenant gets a duplicate
 * row they can clean up, which is recoverable; adopting on a failed probe could
 * re-point a live flow at a different mailbox, which is not.
 */
export function resolveUnlabeledReconnect(
  row: WorkspaceOAuthConnectionRow,
  probedEmail: string | null,
  accountEmail: string,
  aliases: readonly string[] = [],
  probedAccountId: string | null = null,
  accountId: string | null = null
): ReconnectDecision {
  if (probedAccountId && accountId) {
    return probedAccountId === accountId
      ? { kind: "reconnect", row, matchedBy: "account_id" }
      : { kind: "new" };
  }
  if (!probedEmail) return { kind: "new" };
  // Compared against the whole incoming set, not just the primary. The probe
  // runs through the row's OWN grant, so for a personal account it reports the
  // synthetic outlook_<CID>@outlook.com while this connect resolved the real
  // address. Same mailbox, different spelling: comparing one string to one
  // string calls it a stranger and duplicates the row.
  const same = identitySet(accountEmail, aliases).has(probedEmail.trim().toLowerCase());
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
  providerKeys: readonly string[],
  accountId: string | null = null,
  aliases: readonly string[] = []
): WorkspaceOAuthConnectionRow | null {
  const wanted = accountEmail.trim().toLowerCase();
  if (wanted.length === 0) return null;
  const wantedSet = identitySet(wanted, aliases);

  // Same identity rules as findReconnectTarget, for the same reasons. A false
  // match here deletes a row and flips another, the identical damage, so a
  // DIFFERENT account id vetoes everything. And a MISSED match leaves the
  // split-row state this function exists to clean up: two racers for one
  // personal mailbox can label their rows with different representations of
  // the account (the real address vs the synthetic outlook_<CID> UPN), so a
  // single-string label compare is not enough. Id equality is conclusive, and
  // the alias set catches id-less rows written by the Nango-era path.
  const sameAccount = oldestFirst(
    rows.filter((r) => {
      if (!providerKeys.includes(r.provider_config_key)) return false;
      const rowId = accountIdOf(r);
      if (accountId && rowId !== null && rowId !== accountId) return false;
      if (accountId && rowId === accountId) return true;
      return accountAliasesOf(r).some((a) => wantedSet.has(a));
    })
  );
  if (sameAccount.length < 2) return null;

  const keeper = sameAccount[0];
  // Only the row that lost the race backs out. If ours IS the oldest, the other
  // caller will find us and back out itself.
  return keeper.id === insertedRowId ? null : keeper;
}
