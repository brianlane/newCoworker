/**
 * The two "the page tells us we are done here" guards a browse step can carry,
 * and the rule for choosing between them.
 *
 * Both are owner-authored marker strings matched case-insensitively against the
 * page the worker is holding. They differ in what they conclude about the REST
 * of the run, which is the whole point of having two:
 *
 *   skipWhenText      "there is nothing left to do ANYWHERE."
 *                     The run ENDS: step "skipped", run "done".
 *                     e.g. a lead another agent already claimed. Continuing
 *                     would file and text a lead that is not ours.
 *
 *   continueWhenText  "THIS STEP's goal is already met, later steps still
 *                     matter." The step is recorded "skipped" and the run
 *                     CARRIES ON.
 *                     e.g. a portal accept wizard that finished, leaving the
 *                     lead accepted, while its last click timed out on a button
 *                     that had gone inert. Ending there loses the filing, the
 *                     owner email and the teammate hand-off for a lead we now
 *                     own (Amy / Clever, Aug 4 2026).
 *
 * PRECEDENCE: skipWhenText is checked FIRST and wins when both match. The two
 * markers can legitimately both be set on one step, and if a page somehow
 * satisfies both, the safe reading is the one that does LESS. Doing too little
 * costs a lead that a human can still pick up; doing too much means texting a
 * stranger's lead on their behalf.
 *
 * Callers pass whichever page text they hold, and it differs by step type on
 * purpose:
 *   - browse_action matches the FAILURE page only. There is nothing to decide
 *     until an action has failed, and a marker present only on the pre-action
 *     page must not excuse a step that then failed for an unrelated reason.
 *   - browse_extract matches the successfully fetched page, both its visible
 *     text and its raw HTML, because the decision happens before extraction.
 */

/** What the page's markers say to do with the rest of the run. */
export type PageMarkerVerdict = "none" | "end_run" | "continue_run";

/**
 * What a failed browse_action should do with the rest of the run.
 *
 * Page markers still win: if the failure page already proves the step is done
 * (`skipWhenText` / `continueWhenText`), that verdict is the one to follow.
 * `missing_control_continue` is the leftover case: the click waited for the
 * control (CLICK_TEXT_APPEAR_MS) and the page still has no matching button,
 * AND the author opted into `continueWhenMissingControl`. That is a gone
 * control, not a late one. The step is skipped and the run carries on.
 */
export type BrowseActionFailureVerdict = PageMarkerVerdict | "missing_control_continue";

/**
 * Exact phrase `vps/aiflow-render/actions.mjs` throws when `click_text` finds
 * nothing after the appear wait. Matched as a substring of the worker's
 * condensed error, which prefixes the kind/target and may append render
 * diagnostics (HomeLight's usual `_ssgManifest.js` 404s).
 */
export const MISSING_CONTROL_ERROR_NEEDLE = "no matching control on the page";

/** Value written to `missingControlSaveAs` when the missing-control path fires. */
export const MISSING_CONTROL_VAR_VALUE = "missing";

/** True when this browse_action error is a click_text miss after the appear wait. */
export function isMissingControlError(error: string): boolean {
  return error.toLowerCase().includes(MISSING_CONTROL_ERROR_NEEDLE);
}

/** Case-insensitive substring match across every page source the caller holds. */
function anySourceContains(sources: (string | null | undefined)[], marker: string): boolean {
  const needle = marker.toLowerCase();
  return sources.some((s) => typeof s === "string" && s.toLowerCase().includes(needle));
}

/**
 * Decide whether a browse step's page markers fire, and which one.
 *
 * A blank or whitespace-only marker never matches: it would otherwise match
 * every page (`"".includes()` is always true) and silently end or short-circuit
 * every run the step touches. The schema already rejects empty strings, so this
 * is defence for hand-built planner input rather than for authored flows.
 */
export function classifyPageMarkers(
  sources: (string | null | undefined)[],
  markers: { skipWhenText?: string; continueWhenText?: string }
): PageMarkerVerdict {
  const skip = markers.skipWhenText?.trim();
  if (skip && anySourceContains(sources, skip)) return "end_run";
  const cont = markers.continueWhenText?.trim();
  if (cont && anySourceContains(sources, cont)) return "continue_run";
  return "none";
}

/**
 * Classify a failed browse_action. Page-marker guards run first (same
 * precedence as classifyPageMarkers). If they do not fire and the author
 * opted into continueWhenMissingControl, a "no matching control" error
 * continues the run instead of dead-lettering it.
 */
export function classifyBrowseActionFailure(
  sources: (string | null | undefined)[],
  error: string,
  markers: {
    skipWhenText?: string;
    continueWhenText?: string;
    continueWhenMissingControl?: boolean;
  }
): BrowseActionFailureVerdict {
  const page = classifyPageMarkers(sources, markers);
  if (page !== "none") return page;
  if (markers.continueWhenMissingControl === true && isMissingControlError(error)) {
    return "missing_control_continue";
  }
  return "none";
}
