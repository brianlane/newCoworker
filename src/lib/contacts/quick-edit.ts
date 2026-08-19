/**
 * Pure logic behind the Tasks page's lead quick editor (LeadQuickEditor):
 * which fields a save should send, and how a typed tag joins the draft set.
 *
 * Split from the component so the contract is testable. The one that
 * matters: the PATCH body must carry ONLY fields the user actually changed.
 * Sending an unchanged name back is not harmless, the contacts PATCH stamps
 * any non-empty displayName as a manual label (name provenance 'manual'),
 * so echoing a card's RESOLVED name (which may be an owner/employee overlay
 * or a phone fallback, not a stored label) would freeze a derived value
 * into a deliberate one.
 */

import {
  MAX_CONTACT_TAGS,
  MAX_CONTACT_TAG_LENGTH
} from "@/lib/customer-memory/types";

/** The stored values the editor opened on. */
export type ContactQuickEditInitial = {
  /** The RAW stored label (contacts.display_name), not the resolved name. */
  displayName: string | null;
  tags: string[];
  /** The owner the card shows (explicit stamp, or the implicit one). */
  ownerEmployeeId: string | null;
};

/** The editor's current inputs. */
export type ContactQuickEditDraft = {
  displayName: string;
  tags: string[];
  /** Empty string means unassigned. */
  ownerEmployeeId: string;
};

/** Subset of the contacts PATCH body the quick editor may send. */
export type ContactQuickEditPatch = {
  displayName?: string | null;
  tags?: string[];
  ownerEmployeeId?: string | null;
};

/** Tag-list equality via a NUL join: NUL never appears in a tag, so the
 * join cannot collide ("a b"+"c" vs "a"+"b c"). Same trick as the profile
 * editor's dirty check. */
const TAG_JOIN = "\u0000";

/**
 * Build the changed-fields-only PATCH body, or null when nothing changed
 * (the Save button stays disabled on null).
 */
export function buildContactPatch(
  initial: ContactQuickEditInitial,
  draft: ContactQuickEditDraft
): ContactQuickEditPatch | null {
  const patch: ContactQuickEditPatch = {};

  const draftName = draft.displayName.trim();
  if (draftName !== (initial.displayName ?? "")) {
    // Clearing the field clears the label (null resets provenance to auto).
    patch.displayName = draftName === "" ? null : draftName;
  }

  // The editor only adds/removes whole tags, so order-sensitive equality is
  // exact here.
  if (draft.tags.join(TAG_JOIN) !== initial.tags.join(TAG_JOIN)) {
    patch.tags = draft.tags;
  }

  const draftOwner = draft.ownerEmployeeId === "" ? null : draft.ownerEmployeeId;
  if (draftOwner !== initial.ownerEmployeeId) {
    patch.ownerEmployeeId = draftOwner;
  }

  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * Add a typed tag to the draft set: trim, cap the length, and refuse
 * empties, case-insensitive duplicates, and additions past the tag cap.
 * Returns the SAME array when nothing was added, so callers can cheaply
 * detect a no-op.
 */
export function addTagToDraft(tags: string[], raw: string): string[] {
  const tag = raw.trim().slice(0, MAX_CONTACT_TAG_LENGTH);
  if (!tag || tags.length >= MAX_CONTACT_TAGS) return tags;
  if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return tags;
  return [...tags, tag];
}
