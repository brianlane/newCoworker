/**
 * Pure builder: teach Amy's weekly Clever sweep to answer the classification
 * select that SOME cards' update modals require.
 *
 * THE EVIDENCE (2026-08-19, run 5f6b1075). The chained sweep drained 6 of 34
 * cards and then hit its no_progress terminal: every remaining attempt timed
 * out clicking "Submit Update". Probing a failing card (connection 576019)
 * with the modal open showed why. Its "No Status Change" path carries a
 * REQUIRED select most cards do not have:
 *
 *   select id="How would you classify this customer?"
 *     -- Select an option -- | Active/progressing | On hold/nurture | Cold/stagnant
 *
 * Submit stays disabled until it is answered, so those cards fail every pass
 * (6 distinct cards proved in one run: 576019, 564955, 564777, 565155,
 * 564786, 565146), and cards WITHOUT the select would fail a sweep that
 * always tried to answer it. Hence `optional: true` (browse-action support
 * added the same day): answer the select where it exists, skip where it does
 * not, and keep every other failure loud.
 *
 * WHY "Active/progressing". The sweep's note says the client "is active and
 * in ongoing follow-up by phone, text, and email", and the sweep only ever
 * touches the ACTIVE list ("Needs Action" on /portal/<id>/active). A card
 * Amy has put on hold lives in the On Hold list the sweep never walks. The
 * classification therefore states what membership in the swept list already
 * means, the same honesty argument that picked "No Status Change".
 *
 * PLACEMENT. Immediately before "Submit Update", after the notes fill: the
 * select is revealed with the modal (opened by "Provide Update"), and
 * answering it last keeps the action list readable as "status, date, note,
 * classify, submit".
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";

/** The select Clever renders on a subset of update modals. REQUIRED there. */
export const CLASSIFY_SELECT_TARGET = 'select[id="How would you classify this customer?"]';
/** The truthful answer for cards in the swept (active) list. */
export const CLASSIFY_VALUE = "Active/progressing";
/** All options the modal offers, recorded for the next author. */
export const CLASSIFY_OPTIONS = [
  "Active/progressing",
  "On hold/nurture",
  "Cold/stagnant"
] as const;

type Action = Record<string, unknown>;

function actionsOf(step: unknown): Action[] | null {
  const a = (step as { actions?: unknown }).actions;
  return Array.isArray(a) ? (a as Action[]) : [];
}

type BuildResult = {
  definition: AiFlowDefinition;
  changes: string[];
  issues: string[];
};

/**
 * Insert the optional classify action before "Submit Update" in the sweep's
 * forEachLink browse step. Idempotent: no changes when already present.
 */
export function buildClassifySelect(live: AiFlowDefinition): BuildResult {
  const definition = JSON.parse(JSON.stringify(live)) as AiFlowDefinition;
  const changes: string[] = [];
  const issues: string[] = [];

  const sweeps = (definition.steps as FlowStep[]).filter(
    (s) => s.type === "browse_action" && Boolean((s as { forEachLink?: string }).forEachLink)
  );
  if (sweeps.length !== 1) {
    return {
      definition,
      changes,
      issues: [`expected exactly one forEachLink browse step, found ${sweeps.length}`]
    };
  }
  const actions = actionsOf(sweeps[0]);
  if (!actions || actions.length === 0) {
    return { definition, changes, issues: ["the sweep step has no actions"] };
  }

  if (actions.some((a) => a.target === CLASSIFY_SELECT_TARGET)) {
    return { definition, changes, issues };
  }

  const submitAt = actions.findIndex(
    (a) => a.kind === "click_text" && a.target === "Submit Update"
  );
  if (submitAt < 0) {
    return {
      definition,
      changes,
      issues: ['no click_text "Submit Update" action to insert before']
    };
  }

  actions.splice(submitAt, 0, {
    kind: "select_option",
    target: CLASSIFY_SELECT_TARGET,
    valueTemplate: CLASSIFY_VALUE,
    optional: true
  });
  changes.push(
    `+ optional select_option ${CLASSIFY_SELECT_TARGET} = "${CLASSIFY_VALUE}" before Submit Update`
  );
  return { definition, changes, issues };
}
