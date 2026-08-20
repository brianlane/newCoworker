/**
 * Contact identity resolution: the one upsert path every bulk importer uses.
 *
 * Extracted verbatim from the CSV contacts importer (src/lib/csv/contacts.ts)
 * so the Follow Up Boss importer resolves people the exact same way instead
 * of growing a second, subtly different copy. Given a resolved contact key
 * (E.164 number, short code, or `email:` key) plus the caller's update patch
 * and insert payload, this module decides whether the row is:
 *
 *   * an existing contact (primary key OR merged-away alias) -> update it,
 *   * a new number whose EMAIL matches exactly ONE existing customer
 *     profile -> the same person's second number: patch the survivor, then
 *     fold the number in through merge_customer_memories so it lands in
 *     alias_e164s (with the race-free bare-insert-first ordering the CSV
 *     importer established; see the fold comment below),
 *   * otherwise -> create it, retrying as an update when a concurrent
 *     auto-create wins the insert race.
 *
 * The caller keeps ownership of everything row-shaped: which columns go in
 * the patch, what the insert payload is, which events to fire on create.
 * This module only answers "which row is this person, and did we create or
 * update them".
 *
 * Service-role only. Authorization is the API route's job before any call
 * here, same trust model as the CSV importer.
 */

import type { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";
import { escapeLikeLiteral } from "@/lib/privacy/deletion";
import {
  contactAliasOrFilter,
  isEmailContactKey
} from "../../../supabase/functions/_shared/contact_key";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactIdentityUpsertInput = {
  /** Resolved contact key: E.164, short code, or an `email:` key. */
  key: string;
  /**
   * The row's email address (already validated), or null. Drives the
   * email-fold lookup; an email-keyed row must carry its own address here.
   */
  email: string | null;
  /**
   * Column patch for the update/fold paths. The caller includes updated_at
   * and only the columns it means to write (blank cells stay untouched by
   * simply not appearing here).
   */
  patch: Record<string, unknown>;
  /**
   * Insert payload for the create path, minus business_id/customer_e164
   * (added here so the key can never diverge from the lookup).
   */
  insert: Record<string, unknown>;
  /**
   * The row's declared contact type ("" = unspecified). The email fold only
   * runs when the row is (or defaults to) a customer: a row that re-types
   * the contact is a signal they are NOT the same person.
   */
  declaredType?: string;
  /**
   * Extra contact columns to read from the matched row BEFORE the patch is
   * applied (update and fold paths), returned as `before`. Lets a caller
   * merge list columns (tags) or honor fill-only columns (lead_source)
   * without a second lookup.
   */
  readColumns?: readonly string[];
};

export type ContactIdentityUpsertResult = {
  /** Did this row end up creating a contact or updating an existing one? */
  kind: "created" | "updated";
  /**
   * Which path produced it: a plain keyed update, an email fold (patching
   * the survivor and merging the number in), a fold whose merge target
   * vanished mid-flight (promoted to a standalone create), an insert race
   * settled as an update, or a plain insert.
   */
  via: "update" | "fold_patch" | "fold_merge" | "fold_promoted" | "raced_update" | "insert";
  /** The row the person landed on, when the path reveals it. */
  contactId: string | null;
  /**
   * Pre-patch values of `readColumns` on the matched row (update and fold
   * paths); null when the path created a fresh row.
   */
  before: Record<string, unknown> | null;
};

/** The lookup column list: id, the fold's own needs, plus the caller's. */
function selectColumns(base: readonly string[], extra: readonly string[] | undefined): string {
  const cols = [...base];
  for (const c of extra ?? []) {
    if (!cols.includes(c)) cols.push(c);
  }
  return cols.join(", ");
}

/**
 * Resolve one imported row to a contact and apply it. Throws on database
 * errors (message preserved for the caller's per-row error report).
 */
export async function upsertContactIdentity(
  db: SupabaseClient,
  businessId: string,
  input: ContactIdentityUpsertInput
): Promise<ContactIdentityUpsertResult> {
  const { key, email, patch, declaredType, readColumns } = input;

  // Alias-aware update-by-key so a merged-away number updates the surviving
  // profile instead of recreating the one the owner just merged.
  const applyUpdate = async (): Promise<{ id: string; row: Record<string, unknown> } | null> => {
    const lookup = db
      .from("contacts")
      .select(selectColumns(["id"], readColumns))
      .eq("business_id", businessId);
    const aliasFilter = contactAliasOrFilter(key);
    const { data: existing, error: selErr } = await (aliasFilter
      ? lookup.or(aliasFilter)
      : lookup.eq("customer_e164", key)
    ).maybeSingle();
    if (selErr) throw new Error(selErr.message);
    if (!existing) return null;
    // The select string is assembled at runtime, so supabase-js cannot parse
    // a row type out of it; the row is a plain column bag.
    const row = existing as unknown as Record<string, unknown>;
    const id = row.id as string;
    const { error: updErr } = await db.from("contacts").update(patch).eq("id", id);
    if (updErr) throw new Error(updErr.message);
    return { id, row };
  };

  const insertRow = () =>
    db
      .from("contacts")
      .insert({
        business_id: businessId,
        customer_e164: key,
        ...input.insert
      })
      .select("id");

  // Email cross-conflict (ported from BizBlasts' CustomerLinker): the row's
  // number is unknown, but its email already identifies exactly one existing
  // CUSTOMER profile: same person, second number. Strict guards: exactly one
  // email match, both sides classified customer. Race-free by construction:
  // the number is inserted as a BARE row FIRST (the primary-key conflict
  // arbitrates any concurrent inbound auto-create, and a bare row means the
  // merge can't double-apply imported content), then the row's cells land on
  // the SURVIVOR, and only then the battle-tested merge_customer_memories
  // RPC folds the temp row in, locking both rows, recording the number in
  // alias_e164s, and deleting the temp row. Ordering matters: every failure
  // before the merge aborts cleanly (the bare temp row is a harmless
  // standalone contact a re-import updates), so there is no half-merged
  // state the caller's summary can't describe.
  const tryEmailFold = async (): Promise<
    | { state: "no_match" }
    | { state: "raced" }
    | { state: "folded"; via: "fold_patch" | "fold_merge"; id: string; row: Record<string, unknown> }
    | { state: "created_unfolded"; id: string | null }
  > => {
    if (!email) return { state: "no_match" };
    if (declaredType && declaredType !== "customer") return { state: "no_match" };
    const { data: matches, error: matchErr } = await db
      .from("contacts")
      .select(selectColumns(["id", "customer_e164", "type"], readColumns))
      .eq("business_id", businessId)
      .ilike("email", escapeLikeLiteral(email))
      .limit(2);
    if (matchErr) throw new Error(matchErr.message);
    const rows = (matches ?? []) as unknown as Array<Record<string, unknown>>;
    if (rows.length !== 1 || rows[0].type !== "customer") return { state: "no_match" };
    const target = rows[0];
    const targetId = target.id as string;

    // An EMAIL-keyed row has no second number to fold in: the address IS its
    // identity, and the match already carries that address. So this is not a
    // merge, it is the same contact reached the same way. Patch them and
    // stop, rather than creating a second row for one person. (applyUpdate
    // ran first and missed, so the match is a different, phone-keyed contact
    // who gave us this address earlier.)
    if (isEmailContactKey(key)) {
      const { error: patchOnlyErr } = await db
        .from("contacts")
        .update(patch)
        .eq("id", targetId);
      if (patchOnlyErr) throw new Error(patchOnlyErr.message);
      return { state: "folded", via: "fold_patch", id: targetId, row: target };
    }

    const { error: insErr } = await db.from("contacts").insert({
      business_id: businessId,
      customer_e164: key
    });
    if (insErr) {
      if (insErr.code !== PG_UNIQUE_VIOLATION) throw new Error(insErr.message);
      return { state: "raced" };
    }
    // Imported cells are deliberate owner data, apply to the survivor BEFORE
    // the merge so a patch failure aborts the fold cleanly. On that failure
    // the bare temp row is removed again: leaving it would make a RE-IMPORT
    // of the row take the plain keyed-update path (the number now "exists")
    // and silently skip the email fold forever.
    const { error: patchErr } = await db.from("contacts").update(patch).eq("id", targetId);
    if (patchErr) {
      const { error: undoErr } = await db
        .from("contacts")
        .delete()
        .eq("business_id", businessId)
        .eq("customer_e164", key);
      if (undoErr) {
        // Both the patch and the undo failed, surface both so the owner
        // knows the number now exists as a bare contact.
        throw new Error(`${patchErr.message} (temp row cleanup also failed: ${undoErr.message})`);
      }
      throw new Error(patchErr.message);
    }
    const { error: mergeErr } = await db.rpc("merge_customer_memories", {
      p_business_id: businessId,
      p_from_e164: key,
      p_into_e164: target.customer_e164
    });
    if (mergeErr) {
      // The fold target changed under us (deleted/merged mid-import),
      // promote the bare temp row to a full standalone contact instead.
      const { data: promoted, error: promoteErr } = await db
        .from("contacts")
        .update(patch)
        .eq("business_id", businessId)
        .eq("customer_e164", key)
        .select("id");
      if (promoteErr) throw new Error(promoteErr.message);
      const promotedId = ((promoted ?? []) as Array<{ id?: string }>)[0]?.id ?? null;
      return { state: "created_unfolded", id: promotedId };
    }
    return { state: "folded", via: "fold_merge", id: targetId, row: target };
  };

  // Raced by a concurrent auto-create (inbound SMS/call) between the lookup
  // and the insert: the profile exists now, so apply the row's fields as an
  // update rather than dropping them.
  const retryAsUpdate = async (): Promise<ContactIdentityUpsertResult> => {
    const raced = await applyUpdate();
    if (!raced) {
      // The racing row vanished again (e.g. concurrent delete/merge),
      // report it instead of silently losing the row's data.
      throw new Error(`A concurrent change kept ${key} from being saved; re-import this row.`);
    }
    return { kind: "updated", via: "raced_update", contactId: raced.id, before: raced.row };
  };

  const updated = await applyUpdate();
  if (updated) {
    return { kind: "updated", via: "update", contactId: updated.id, before: updated.row };
  }
  const fold = await tryEmailFold();
  if (fold.state === "folded") {
    return { kind: "updated", via: fold.via, contactId: fold.id, before: fold.row };
  }
  if (fold.state === "created_unfolded") {
    return { kind: "created", via: "fold_promoted", contactId: fold.id, before: null };
  }
  if (fold.state === "raced") {
    return retryAsUpdate();
  }
  const { data: inserted, error: insErr } = await insertRow();
  if (insErr) {
    if (insErr.code !== PG_UNIQUE_VIOLATION) throw new Error(insErr.message);
    return retryAsUpdate();
  }
  const insertedId = ((inserted ?? []) as Array<{ id?: string }>)[0]?.id ?? null;
  return { kind: "created", via: "insert", contactId: insertedId, before: null };
}
