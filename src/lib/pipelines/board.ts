/**
 * Pure board-shaping helpers: which stage a contact's tags put it in, and
 * how a list of lead cards distributes across a pipeline's columns.
 *
 * Matching is case-insensitive everywhere (tags are de-duped
 * case-insensitively on write, and AiFlow update_contact compares the same
 * way), and a contact carrying SEVERAL of a pipeline's stage tags renders
 * in the FURTHEST stage (highest position) — the most-advanced state wins,
 * matching how a lead accumulates "Contacted" after "New Lead" when a flow
 * forgets the removal.
 */

import type { PipelineStage } from "./types";

/** The minimum stage shape the pure helpers need. */
export type StageRef = Pick<PipelineStage, "id" | "name" | "position">;

/**
 * The stage this tag set puts a contact in: the highest-position stage
 * whose name appears among the tags, or null when none do (the contact is
 * not on this pipeline's board).
 */
export function stageForTags(stages: StageRef[], tags: string[]): StageRef | null {
  const lowered = new Set(tags.map((t) => t.trim().toLowerCase()));
  let best: StageRef | null = null;
  for (const stage of stages) {
    if (!lowered.has(stage.name.trim().toLowerCase())) continue;
    if (best === null || stage.position > best.position) best = stage;
  }
  return best;
}

/**
 * Distribute cards across a pipeline's columns. Returns a map keyed by
 * stage id, every stage present (empty columns included) so the board can
 * render all of them; cards whose tags match no stage are omitted — they
 * are simply not on this pipeline.
 */
export function groupCardsByStage<T extends { tags: string[] }>(
  stages: StageRef[],
  cards: T[]
): Map<string, T[]> {
  const byStage = new Map<string, T[]>(stages.map((s) => [s.id, []]));
  for (const card of cards) {
    const stage = stageForTags(stages, card.tags);
    if (!stage) continue;
    byStage.get(stage.id)!.push(card);
  }
  return byStage;
}

/** Is this tag one of the pipeline's stage tags (case-insensitive)? */
export function isStageTag(stages: StageRef[], tag: string): boolean {
  const key = tag.trim().toLowerCase();
  return stages.some((s) => s.name.trim().toLowerCase() === key);
}
