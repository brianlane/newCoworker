/**
 * The automation side of a contact edit, shared by every dashboard surface
 * that changes tags or owner on a contact row: the single-contact PATCH
 * route (profile page, LeadQuickEditor) and the bulk-action path.
 *
 * Extracted from the PATCH route so a bulk edit fires EXACTLY the events a
 * one-at-a-time edit fires (tag_added goal events, tag_changed and
 * owner_assigned AiFlow triggers). A second copy of this diff would drift;
 * a raw bulk UPDATE would skip it entirely and strand parked runs.
 *
 * Both entry points are best-effort by construction: fireGoalEvent and
 * fireContactEvent never throw, so a trigger failure never fails the write
 * that observed it.
 */

import { normalizeContactTags } from "@/lib/customer-memory/types";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { getTeamMember } from "@/lib/db/employees";

export type TagChangeEventInput = {
  /** The row's PRIMARY key (post alias resolution), never an alias spelling. */
  canonicalE164: string;
  /** Merged-away numbers linked to the row (contacts.alias_e164s). */
  aliasE164s: string[];
  /** The stored tag set BEFORE the write (raw; normalized here). */
  previousTags: string[];
  /** The tag set the write sent (raw; normalized here). */
  nextTags: string[];
};

/**
 * Fire Goal Events + tag_changed triggers for the tags an edit ADDED or
 * REMOVED (vs. the pre-edit row): they may fast-forward parked runs to a
 * "tag added" goal and/or start flows watching for the change.
 */
export async function fireTagChangeEvents(
  businessId: string,
  input: TagChangeEventInput
): Promise<void> {
  // Both sides of the diff go through the SAME normalization the write
  // used, comparing raw stored tags would make a legacy spelling or stray
  // whitespace look "new" and fire a spurious event.
  const nextTags = normalizeContactTags(input.nextTags);
  const previousTags = normalizeContactTags(input.previousTags);
  const before = new Set(previousTags.map((t) => t.toLowerCase()));
  const after = new Set(nextTags.map((t) => t.toLowerCase()));
  const eventStamp = Date.now();
  // Runs match goal events by the exact number they were triggered with,
  // which after a profile merge may be an ALIAS, fire for every linked
  // number so a parked run keyed on the old number still jumps.
  const goalNumbers = [input.canonicalE164, ...input.aliasE164s];
  for (const tag of nextTags) {
    if (before.has(tag.toLowerCase())) continue;
    for (const number of goalNumbers) {
      await fireGoalEvent(businessId, number, { kind: "tag_added", tag });
    }
    await fireContactEvent(businessId, {
      kind: "tag_changed",
      contact: { e164: input.canonicalE164, tags: nextTags },
      tag,
      change: "added",
      dedupeKey: `ce:tag:${input.canonicalE164}:${tag.toLowerCase()}:added:${eventStamp}`
    });
  }
  for (const tag of previousTags) {
    if (after.has(tag.toLowerCase())) continue;
    await fireContactEvent(businessId, {
      kind: "tag_changed",
      contact: { e164: input.canonicalE164, tags: nextTags },
      tag,
      change: "removed",
      dedupeKey: `ce:tag:${input.canonicalE164}:${tag.toLowerCase()}:removed:${eventStamp}`
    });
  }
}

export type OwnerAssignedEventInput = {
  /** The row's PRIMARY key (post alias resolution). */
  canonicalE164: string;
  /** The stored owner BEFORE the write (contacts.owner_employee_id). */
  previousOwnerEmployeeId: string | null;
  /** The owner the edit set; null (a clear) never fires. */
  ownerEmployeeId: string | null;
};

/**
 * Fire the owner_assigned trigger for a manual owner pick: only when the
 * owner actually CHANGED to someone new (a clear, or re-picking the current
 * owner, is not an assignment). The member lookup is best-effort; a missing
 * or failing roster read just drops the name from the event.
 */
export async function fireOwnerAssignedEvent(
  businessId: string,
  input: OwnerAssignedEventInput
): Promise<void> {
  if (
    input.ownerEmployeeId === null ||
    input.ownerEmployeeId === input.previousOwnerEmployeeId
  ) {
    return;
  }
  const member = await getTeamMember(businessId, input.ownerEmployeeId).catch(() => null);
  await fireContactEvent(businessId, {
    kind: "owner_assigned",
    contact: { e164: input.canonicalE164 },
    ...(member?.name ? { ownerName: member.name } : {}),
    dedupeKey: `ce:owner:${input.canonicalE164}:${input.ownerEmployeeId}:${Date.now()}`
  });
}
