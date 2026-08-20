/**
 * Bulk contact actions (customers page multi-select): add a tag, remove a
 * tag, or assign an owner across many contacts in one request.
 *
 * The contract that matters: every change goes through the SAME per-contact
 * write path the single-contact editor uses (alias-aware getCustomerMemory,
 * updateCustomerOwnerFields, then the shared edit-events diff), one contact
 * at a time, in selection order. Tag automations (tag_changed AiFlow
 * triggers, tag_added goal events) and owner_assigned triggers fire exactly
 * as they would had the owner edited each contact by hand. There is
 * deliberately NO raw bulk UPDATE shortcut here: it would skip the event
 * diff, strand parked runs, and start nothing the owner was promised.
 *
 * Failure model is row-by-row, never all-or-nothing (same as the CSV
 * importer): one contact's failure is recorded and the rest still apply.
 *
 * Service-role only. Authorization is the API route's job (the same
 * operate_messages gate as the single-contact PATCH), same trust model as
 * customer-memory/db.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { BULK_MAX_CONTACTS } from "@/lib/contacts/bulk-constants";
import {
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import {
  MAX_CONTACT_TAGS,
  MAX_CONTACT_TAG_LENGTH,
  normalizeContactTags
} from "@/lib/customer-memory/types";
import { getTeamMember } from "@/lib/db/employees";
import {
  fireOwnerAssignedEvent,
  fireTagChangeEvents
} from "@/lib/contacts/edit-events";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export { BULK_MAX_CONTACTS };

export type BulkContactAction =
  | { action: "add_tag"; tag: string }
  | { action: "remove_tag"; tag: string }
  | { action: "assign_owner"; employeeId: string };

export type BulkContactResult = {
  /** The contact key as requested (E.164, short code, or `email:` key). */
  key: string;
  /** True when the contact now has the requested state (including no-ops). */
  ok: boolean;
  /** Owner-readable reason when ok is false. */
  error?: string;
};

export type BulkContactSummary = {
  /** One entry per requested key, in request order. */
  results: BulkContactResult[];
  updated: number;
  failed: number;
};

/** Whole-request refusal (bad input); the route maps it to a 400. */
export class BulkContactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkContactError";
  }
}

/**
 * Apply one action to many contacts, sequentially, returning the per-contact
 * outcome plus totals. Sequential on purpose: contact events must land one
 * contact at a time, in order, exactly like hand-editing each row; parallel
 * writes would interleave automation enqueues.
 */
export async function applyBulkContactAction(
  businessId: string,
  contactKeys: string[],
  action: BulkContactAction,
  client?: SupabaseClient
): Promise<BulkContactSummary> {
  if (contactKeys.length === 0) {
    throw new BulkContactError("Select at least one contact.");
  }
  if (contactKeys.length > BULK_MAX_CONTACTS) {
    throw new BulkContactError(
      `At most ${BULK_MAX_CONTACTS} contacts per request; apply larger selections in batches.`
    );
  }

  let tag = "";
  if (action.action === "add_tag" || action.action === "remove_tag") {
    tag = action.tag.trim();
    if (!tag) throw new BulkContactError("Enter a tag.");
    if (tag.length > MAX_CONTACT_TAG_LENGTH) {
      throw new BulkContactError(`Tags are at most ${MAX_CONTACT_TAG_LENGTH} characters.`);
    }
  }

  const db = client ?? (await createSupabaseServiceClient());

  // An assigned owner must be on THIS business's roster (active or not,
  // matching the single-contact PATCH). Checked ONCE up front and refused
  // for the whole request, because it can never succeed for any contact.
  if (action.action === "assign_owner") {
    const member = await getTeamMember(businessId, action.employeeId, db);
    if (!member) {
      throw new BulkContactError("That employee is not on this business's roster");
    }
  }

  const results: BulkContactResult[] = [];
  for (const key of contactKeys) {
    try {
      results.push(await applyToOneContact(db, businessId, key, action, tag));
    } catch (e) {
      results.push({
        key,
        ok: false,
        error: e instanceof Error ? e.message : "Unexpected error"
      });
    }
  }
  const updated = results.filter((r) => r.ok).length;
  return { results, updated, failed: results.length - updated };
}

/** One contact's worth of the action: the same steps a single edit takes. */
async function applyToOneContact(
  db: SupabaseClient,
  businessId: string,
  key: string,
  action: BulkContactAction,
  tag: string
): Promise<BulkContactResult> {
  // Alias-aware, same read the single edit starts from. Writes (and events)
  // go against the resolved row's PRIMARY key, never the requested spelling:
  // updateCustomerOwnerFields filters on customer_e164 only, so an alias
  // spelling would update nothing while events fired anyway.
  const existing = await getCustomerMemory(businessId, key, db);
  if (!existing) return { key, ok: false, error: "Contact not found" };
  const canonicalE164 = existing.customer_e164;
  const aliasE164s = existing.alias_e164s ?? [];

  if (action.action === "assign_owner") {
    if (existing.owner_employee_id === action.employeeId) {
      // Already theirs: nothing to write, and no owner_assigned refire.
      return { key, ok: true };
    }
    await updateCustomerOwnerFields(
      businessId,
      canonicalE164,
      { ownerEmployeeId: action.employeeId },
      db
    );
    await fireOwnerAssignedEvent(businessId, {
      canonicalE164,
      previousOwnerEmployeeId: existing.owner_employee_id,
      ownerEmployeeId: action.employeeId
    });
    return { key, ok: true };
  }

  const previousTags = existing.tags ?? [];
  // Case-insensitive, whitespace-tolerant identity, matching the normalized
  // spelling every write path stores (a legacy " VIP " still counts as VIP).
  const matchesTag = (t: string) => t.trim().toLowerCase() === tag.toLowerCase();

  if (action.action === "add_tag") {
    if (previousTags.some(matchesTag)) {
      // Desired state already holds; a rewrite would fire no events anyway.
      return { key, ok: true };
    }
    if (normalizeContactTags(previousTags).length >= MAX_CONTACT_TAGS) {
      // The write path's cap would silently DROP the new tag; succeeding
      // here would be an ok that committed nothing.
      return {
        key,
        ok: false,
        error: `This contact already has the maximum of ${MAX_CONTACT_TAGS} tags`
      };
    }
    const nextTags = [...previousTags, tag];
    await updateCustomerOwnerFields(businessId, canonicalE164, { tags: nextTags }, db);
    await fireTagChangeEvents(businessId, {
      canonicalE164,
      aliasE164s,
      previousTags,
      nextTags
    });
    return { key, ok: true };
  }

  // remove_tag
  if (!previousTags.some(matchesTag)) {
    // Nothing to remove; desired state already holds.
    return { key, ok: true };
  }
  const nextTags = previousTags.filter((t) => !matchesTag(t));
  await updateCustomerOwnerFields(businessId, canonicalE164, { tags: nextTags }, db);
  await fireTagChangeEvents(businessId, {
    canonicalE164,
    aliasE164s,
    previousTags,
    nextTags
  });
  return { key, ok: true };
}
