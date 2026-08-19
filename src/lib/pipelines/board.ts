/**
 * Board-shaping helpers: which stage a contact's tags put it in, and how a
 * list of lead cards distributes across a pipeline's columns.
 *
 * `stageForTags` / `isStageTag` live in
 * `supabase/functions/_shared/pipelines/stages.ts` so the Deno AiFlow worker
 * shares one implementation with the app (the worker cannot resolve the `@/`
 * alias); they are re-exported here so every existing consumer keeps its
 * import path. `groupCardsByStage` is UI-only and stays.
 */

import {
  stageForTags,
  type StageRef
} from "../../../supabase/functions/_shared/pipelines/stages";

export {
  stageForTags,
  isStageTag,
  type StageRef
} from "../../../supabase/functions/_shared/pipelines/stages";

/**
 * Distribute cards across a pipeline's columns. Returns a map keyed by
 * stage id, every stage present (empty columns included) so the board can
 * render all of them; cards whose tags match no stage are omitted, they
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
