/**
 * Pure builder: switch Amy's weekly Clever sweep from "We Spoke" to
 * "No Status Change".
 *
 * WHY THIS IS A BUG FIX AND NOT A WORDING PREFERENCE.
 *
 * Clever's "Provide Update" modal asks "What is the new status?" and the option
 * list it offers is a FORWARD-ONLY PROGRESSION FROM THE CARD'S CURRENT STAGE.
 * Read live on 2026-08-18 in a signed-in browser, on two cards:
 *
 *   card at "Tried Reaching Out"      card at "Spoke"
 *   ----------------------------      ---------------------------
 *   No Status Change                  No Status Change
 *   We Spoke                          (absent)
 *   We Scheduled A Meeting            We Scheduled A Meeting
 *   We Met In-Person                  We Met In-Person
 *   We Signed a Listing Agreement     We Signed a Listing Agreement
 *   We Listed the Home For Sale       We Listed the Home For Sale
 *   We're Under Contract              We're Under Contract
 *   We Closed                         We Closed
 *   Released: No Longer Pursuing      Released: No Longer Pursuing
 *
 * **"We Spoke" does not exist on a card that has already reached "Spoke".** The
 * weekly sweep runs over EVERY active deal, and most of Amy's book is already
 * past that point (87 cards in "Recently Updated", the majority showing
 * "Spoke"). So the sweep this repo shipped would have failed its second action
 * on most cards, and `performForEach` counts a per-item action failure as
 * `failed` and moves on: a sweep that looked like it ran and updated almost
 * nothing.
 *
 * "No Status Change" is the FIRST option on both lists and on every stage. It is
 * also the honest one: a weekly compliance ping is not a claim that a new
 * conversation happened. The two properties are the same property here, which is
 * the useful part. Picking the truthful option is also what makes it work.
 *
 * THE ACTION LIST GETS SHORTER, NOT JUST DIFFERENT.
 *
 * Choosing "We Spoke" reveals a required `<select>` ("Did you schedule a time to
 * meet in person?"). Choosing "No Status Change" does NOT: step 2 is only
 * `Notes *` and `When do you plan to follow up again? *`, both required, with
 * `Submit Update` disabled until they are filled. So the `select_option` action
 * has to be REMOVED, not retargeted. Leaving it in would fail on a control that
 * is never rendered.
 *
 * The date picker is unchanged and still a react-datepicker whose day cells are
 * `role="option"` named "Choose Wednesday, August 26th, 2026", with `HH:MM`
 * times, so the existing `{{now.in7Days.*}}` templating still matches.
 *
 * WHAT IS NOT CHANGED. The daily (Chris) flow keeps "We Spoke". It fires on the
 * day a lead arrives, when the card is at "Tried Reaching Out" or "New" and
 * "We Spoke" IS offered, and 34 successful runs say it resolves. Its own
 * honesty question (does the AI's outreach amount to having spoken?) is a
 * separate call and is left alone here rather than bundled into a bug fix.
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

/** The status the weekly sweep should post. Present on every card, every stage. */
export const STATUS_NO_CHANGE = "No Status Change";
/** The status it posts today, which most cards do not offer. */
export const STATUS_WE_SPOKE = "We Spoke";

/** The meeting select exists ONLY on the "We Spoke" path and must be dropped. */
export const MEETING_SELECT_TARGET =
  'select[id="Did you schedule a time to meet in person?"]';

/** Every status Clever offers, in portal order. Recorded for the next author. */
export const CLEVER_STATUSES = [
  "No Status Change",
  "We Spoke",
  "We Scheduled A Meeting",
  "We Met In-Person",
  "We Signed a Listing Agreement",
  "We Listed the Home For Sale",
  "We're Under Contract",
  "We Closed",
  "Released: No Longer Pursuing"
] as const;

type Action = Record<string, string>;

function actionsOf(step: unknown): Action[] | null {
  const a = (step as { actions?: unknown }).actions;
  return Array.isArray(a) ? (a as Action[]) : null;
}

/**
 * Rewrite the sweep's action list in place. Returns a human-readable list of
 * what changed, empty when it already says this.
 */
export function switchToNoStatusChange(def: AiFlowDefinition): string[] {
  const changes: string[] = [];
  for (const step of def.steps) {
    const actions = actionsOf(step);
    if (!actions) continue;

    const status = actions.find(
      (a) => a.kind === "click_text" && a.target === STATUS_WE_SPOKE
    );
    if (status) {
      status.target = STATUS_NO_CHANGE;
      changes.push(`status "${STATUS_WE_SPOKE}" -> "${STATUS_NO_CHANGE}"`);
    }

    // Drop the meeting select: it is revealed by "We Spoke" and never rendered
    // on the "No Status Change" path, so keeping it fails every card.
    const meetingAt = actions.findIndex(
      (a) => a.kind === "select_option" && a.target === MEETING_SELECT_TARGET
    );
    if (meetingAt >= 0) {
      actions.splice(meetingAt, 1);
      changes.push(`- select_option "${MEETING_SELECT_TARGET}" (only exists under "${STATUS_WE_SPOKE}")`);
    }
  }
  return changes;
}

/** Convenience for the applier and tests. */
export function buildSweep(live: AiFlowDefinition): {
  definition: AiFlowDefinition;
  changes: string[];
} {
  const next = JSON.parse(JSON.stringify(live)) as AiFlowDefinition;
  return { definition: next, changes: switchToNoStatusChange(next) };
}
