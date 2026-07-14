/**
 * The tag delta for moving a contact between pipeline stages.
 *
 * Stage = tag, so a move is exactly one status transition on the tag set:
 * strip EVERY stage tag of this pipeline (a lead sits in one column at a
 * time), then add the target stage's tag. Non-pipeline tags ("VIP",
 * "spanish-speaking") survive untouched, and the normalization mirrors the
 * platform's single tag ruleset (trim, 40-char clamp, case-insensitive
 * de-dup, 25-tag cap) so a board move writes exactly what the dashboard
 * editor or an AiFlow update_contact step would.
 */

import { MAX_CONTACT_TAGS, MAX_CONTACT_TAG_LENGTH } from "@/lib/customer-memory/types";

export type StageMoveDelta = {
  /** The full tag set to write on the contact. */
  nextTags: string[];
  /** Stage tags actually added (empty when the contact was already there). */
  added: string[];
  /** Stage tags actually stripped (only ones that were really present). */
  removed: string[];
  /** True when the 25-tag cap blocked the target tag from landing. */
  droppedAtCap: boolean;
};

/**
 * Compute the move. `stageNames` is every stage tag of the pipeline being
 * moved on; `targetStageName` is the destination stage's tag, or null to
 * take the contact OFF the board (strip all stage tags, add nothing).
 */
export function computeStageMove(
  currentTags: string[],
  stageNames: string[],
  targetStageName: string | null
): StageMoveDelta {
  const target = targetStageName?.trim().slice(0, MAX_CONTACT_TAG_LENGTH) || null;
  const targetKey = target?.toLowerCase() ?? null;
  // Every pipeline stage tag except the destination gets stripped.
  const removeSet = new Set(
    stageNames
      .map((n) => n.trim().toLowerCase())
      .filter((k) => k.length > 0 && k !== targetKey)
  );

  const seen = new Set<string>();
  const nextTags: string[] = [];
  const removed: string[] = [];
  let alreadyThere = false;
  for (const raw of currentTags) {
    const tag = raw.trim().slice(0, MAX_CONTACT_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    if (removeSet.has(key)) {
      removed.push(tag);
      continue;
    }
    if (key === targetKey) alreadyThere = true;
    seen.add(key);
    nextTags.push(tag);
  }

  const added: string[] = [];
  let droppedAtCap = false;
  if (target && !alreadyThere) {
    if (nextTags.length >= MAX_CONTACT_TAGS) {
      droppedAtCap = true;
    } else {
      nextTags.push(target);
      added.push(target);
    }
  }

  return { nextTags, added, removed, droppedAtCap };
}
