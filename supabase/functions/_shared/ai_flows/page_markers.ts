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
