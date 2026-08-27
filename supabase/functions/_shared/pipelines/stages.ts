/**
 * Pure pipeline-stage logic, shared by the Deno AiFlow worker and the Next
 * app.
 *
 * A pipeline stage IS a contact tag: a contact "is in" a stage when
 * `contacts.tags` carries the stage's name (case-insensitively, like every
 * other tag comparison in the platform). The board is a view over tags, with
 * no opportunities table behind it.
 *
 * This module lives in `_shared` rather than `src/lib/pipelines/` because the
 * worker cannot import through the `@/` alias, and it is the same coverage
 * gate either way (vitest.config.ts covers `supabase/functions/_shared/**`
 * alongside `src/lib/**` at 100%). `src/lib/pipelines/board.ts` and
 * `src/lib/pipelines/move.ts` re-export from here, so every existing consumer
 * keeps its import path.
 */

/**
 * The platform tag ruleset, inlined rather than imported from
 * `src/lib/customer-memory/types` (the `@/` alias is Next-only, and that
 * module is coverage-excluded). `tests/pipelines-board.test.ts` asserts these
 * equal the originals, so the two cannot drift.
 */
export const MAX_STAGE_TAGS = 25;
export const MAX_STAGE_TAG_LENGTH = 40;

/** The minimum stage shape the pure helpers need. */
export type StageRef = {
  id: string;
  /** The stage IS this contact tag (case-insensitive match). */
  name: string;
  /** 0-based board order, left to right. */
  position: number;
};

/**
 * The stage this tag set puts a contact in: the highest-position stage whose
 * name appears among the tags, or null when none do (the contact is not on
 * this pipeline's board).
 *
 * The most-advanced state wins, matching how a lead accumulates "Contacted"
 * after "New Lead" when a flow forgets the removal.
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

/** Is this tag one of the pipeline's stage tags (case-insensitive)? */
export function isStageTag(stages: StageRef[], tag: string): boolean {
  const key = tag.trim().toLowerCase();
  return stages.some((s) => s.name.trim().toLowerCase() === key);
}

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
 * The tag delta for moving a contact between pipeline stages.
 *
 * Stage = tag, so a move is exactly one status transition on the tag set:
 * strip EVERY stage tag of this pipeline (a lead sits in one column at a
 * time), then add the target stage's tag. Non-pipeline tags ("VIP",
 * "spanish-speaking") survive untouched, and the normalization mirrors the
 * platform's single tag ruleset (trim, 40-char clamp, case-insensitive
 * de-dup, 25-tag cap) so a board move writes exactly what the dashboard
 * editor or an AiFlow update_contact step would.
 *
 * `stageNames` is every stage tag of the pipeline being moved on;
 * `targetStageName` is the destination stage's tag, or null to take the
 * contact OFF the board (strip all stage tags, add nothing).
 */
export function computeStageMove(
  currentTags: string[],
  stageNames: string[],
  targetStageName: string | null
): StageMoveDelta {
  const target = targetStageName?.trim().slice(0, MAX_STAGE_TAG_LENGTH) || null;
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
    const tag = raw.trim().slice(0, MAX_STAGE_TAG_LENGTH);
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
    if (nextTags.length >= MAX_STAGE_TAGS) {
      droppedAtCap = true;
    } else {
      nextTags.push(target);
      added.push(target);
    }
  }

  return { nextTags, added, removed, droppedAtCap };
}

/**
 * The lifecycle moments the PLATFORM advances a lead through, and the stage
 * tag each one writes.
 *
 * These names are `DEFAULT_PIPELINE.stages` (src/lib/pipelines/types.ts).
 *
 * Each moment is a sibling of an existing `GoalEventKind` call site, so the
 * tagger rides instrumentation the engine already had rather than adding new
 * hooks: lead_filed at `enrichCustomerProfile`, claimed at
 * `assignContactOwnerOnClaim`, replied at the inbound SMS webhook, booked at
 * every `appointment_booked` goal event, contacted at the prospecting sweep's
 * reconcile phase (NOT at the send: the cold-emailed prospect has no contact
 * row yet, the outreach flow files it a minute later, so the stage is applied
 * on the next pass once there is something to tag).
 *
 * `met` and `won` are the meeting-minutes pair (src/lib/meetings/), fired
 * after a recorded meeting is condensed and classified. They are the only
 * moments here that come from READING content rather than from an event
 * firing, so they carry the one caveat the others do not: the input is a
 * transcript of what a third party said, and the classifier is what stands
 * between that and the board.
 *
 * "Won" USED to be excluded from this map on the grounds that won is a human
 * judgement. That held while the platform's only signals were mechanical
 * (a lead was filed, a booking existed): none of them can tell a closed deal
 * from a booked call, so writing Won from them would have been a guess.
 * A meeting where the guest agreed to move forward is different in kind, and
 * it is the one moment a business most wants reflected on the board without
 * having to go and drag a card. The board's move endpoint still owns the
 * human path, and forward-only means a human can always drag a card back
 * without the platform re-writing it.
 */
export const LIFECYCLE_STAGE_TAGS = {
  lead_filed: "New Lead",
  claimed: "Contacted",
  // We emailed them. Shares a tag with `claimed` on purpose: both mean the
  // lead has been reached, and the board asks "has anyone touched this?", not
  // "who touched it?". Kept a separate EVENT because the two happen at
  // different moments from different code, and collapsing them would make the
  // outreach path depend on a teammate claiming something first.
  contacted: "Contacted",
  replied: "Engaged",
  booked: "Booked",
  // A recorded meeting actually happened and was about this lead. Shares
  // "Engaged" with `replied` for the same reason `contacted` shares
  // "Contacted": the board asks whether the lead is in conversation, and a
  // meeting is the strongest possible yes. Forward-only keeps this from
  // dragging a Booked lead backwards after a call.
  met: "Engaged",
  // The meeting classifier read a commitment to move forward. The ONLY
  // platform path to Won, and the only lifecycle tag whose trigger is a
  // model's reading rather than an event: see the note above.
  won: "Won"
} as const;

export type LifecycleEvent = keyof typeof LIFECYCLE_STAGE_TAGS;

/** One pipeline's stages, as the planner needs them. */
export type PipelineStages = {
  pipelineId: string;
  /** Ordered by position ascending. */
  stages: StageRef[];
};

export type LifecycleStagePlan = {
  /** The full tag set to write, or the input tags when nothing changed. */
  nextTags: string[];
  /** True when a write is actually needed. */
  changed: boolean;
  added: string[];
  removed: string[];
  /** Pipelines this event actually moved the contact on. */
  matchedPipelineIds: string[];
  /** True when the tag cap blocked the target on at least one pipeline. */
  droppedAtCap: boolean;
};

/**
 * Decide what a lifecycle event should write, across every pipeline the
 * business has.
 *
 * Three rules, each load-bearing:
 *
 *   1. STAGE MUST EXIST. A pipeline that has no stage named for this event is
 *      skipped entirely. Since stage IS tag, writing a tag with no column
 *      behind it produces invisible junk that still consumes the 25-tag cap
 *      and still fires `tag_changed`. A business with no pipeline gets
 *      nothing; a business that renamed "Contacted" to "Working" gets nothing
 *      for that moment. Opting in is creating the stage.
 *
 *   2. FORWARD ONLY. A contact already at or past the target position is left
 *      alone, so a re-filed lead is never dragged back from Booked to New
 *      Lead and a repeating trigger (every inbound text fires `replied`)
 *      transitions exactly once. This bounds the platform to four forward
 *      moves per contact per pipeline, ever.
 *
 *   3. CAP IS ALL OR NOTHING. When `computeStageMove` reports `droppedAtCap`
 *      the whole delta for that pipeline is discarded. Writing `nextTags`
 *      anyway would strip the old stage tag and add nothing, silently
 *      knocking the lead off the board. In practice a contact that already
 *      holds a stage tag frees the slot it needs by stripping it, so this
 *      fires for a contact at the cap with 25 NON-stage tags.
 *
 * Multiple pipelines compose into ONE contact write: `nextTags` threads
 * forward through the loop.
 */
export function planLifecycleStageWrites(input: {
  event: LifecycleEvent;
  currentTags: string[];
  pipelines: PipelineStages[];
}): LifecycleStagePlan {
  const targetName = LIFECYCLE_STAGE_TAGS[input.event];
  const targetKey = targetName.toLowerCase();

  let tags = input.currentTags;
  const added: string[] = [];
  const removed: string[] = [];
  const matchedPipelineIds: string[] = [];
  let droppedAtCap = false;

  for (const pipeline of input.pipelines) {
    const target = pipeline.stages.find(
      (s) => s.name.trim().toLowerCase() === targetKey
    );
    // Rule 1: this board has no column for this moment.
    if (!target) continue;

    // Rule 2: never move a lead backwards.
    const current = stageForTags(pipeline.stages, tags);
    if (current && current.position >= target.position) continue;

    const delta = computeStageMove(
      tags,
      pipeline.stages.map((s) => s.name),
      target.name
    );
    // Rule 3: a capped move would strip without adding.
    if (delta.droppedAtCap) {
      droppedAtCap = true;
      continue;
    }

    tags = delta.nextTags;
    added.push(...delta.added);
    removed.push(...delta.removed);
    matchedPipelineIds.push(pipeline.pipelineId);
  }

  return {
    nextTags: tags,
    changed: added.length > 0 || removed.length > 0,
    added,
    removed,
    matchedPipelineIds,
    droppedAtCap
  };
}
