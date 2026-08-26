/**
 * What the flow History panel shows: for each recorded snapshot, WHAT the
 * edit that replaced it actually did, in the same plain English the AI
 * confirm handshake reads back.
 *
 * `ai_flow_definition_versions` rows carry the state BEFORE each edit and
 * nothing about the edit itself (see versions.ts), so describing an edit
 * means pairing a row with whatever replaced it: the next-newer row, or, for
 * the newest row, the definition that is live right now. That pairing is an
 * off-by-one worth keeping out of a component, where nothing tests it.
 *
 * Pure: no IO, no model call. The component renders these entries verbatim.
 */
import { diffFlowDefinitions } from "@/lib/ai-flows/edit-diff";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import type { AiFlowVersionRow } from "@/lib/ai-flows/versions";
import { ownerSurfaceByFlowEditSource } from "@/lib/owner-surfaces/registry";

/** One row of the History panel, newest first. */
export type FlowHistoryEntry = {
  /** `ai_flow_definition_versions.id`, what Restore is called with. */
  versionId: number;
  /** The flow's name in this snapshot. */
  name: string;
  /** When this state stopped being live (ISO). */
  replacedAt: string;
  /** Who or what made the edit that replaced it, in plain English. */
  by: string;
  /** The stamped actor (an email, usually), when the writer recorded one. */
  actor: string | null;
  /**
   * Plain-English lines describing the edit that replaced this snapshot.
   * Empty when the two states are equivalent, which is what a name-only or
   * enabled-only write records (`enabled` is its own control with its own
   * history, and the trigger snapshots every write regardless).
   */
  changeSummary: string[];
  /** True for the newest row: restoring it undoes the most recent edit. */
  isMostRecent: boolean;
};

/**
 * Plain-English provenance for an `ai_flows.edit_source` stamp.
 *
 * Unstamped rows are the common case for anything written straight through
 * PostgREST by a `debug/` or `scripts/oneshot/` script, and for every row
 * predating the stamp. "An earlier change" is deliberately vague rather than
 * guessing: a false attribution is worse than an absent one (the same reason
 * the trigger nulls the carrier columns after copying them).
 */
export function describeEditSource(source: string | null): string {
  // Coworker surfaces answer from the registry, so a newly registered one
  // is described here without this switch being touched.
  const surface = ownerSurfaceByFlowEditSource(source);
  if (surface) return surface.historyLabel;
  switch (source) {
    case "dashboard":
      return "Edited in the builder";
    case "dashboard_restore":
      return "Restored from history";
    case "ai_edit":
      return "Edited by your coworker";
    case "mcp":
      return "Edited through a connected app";
    case "mcp_restore":
      return "Restored through a connected app";
    case "white_glove":
      return "Edited by the New Coworker team";
    default:
      return "An earlier change";
  }
}

/**
 * Build the History panel's rows from newest-first snapshots plus the live
 * state. `versions` must be in the order `listFlowVersions` returns.
 */
export function buildFlowHistory(
  versions: AiFlowVersionRow[],
  current: { name: string; definition: AiFlowDefinition }
): FlowHistoryEntry[] {
  return versions.map((row, index) => {
    // What replaced this snapshot: the next-NEWER row, or the live state for
    // the newest one. `index - 1` because the list runs newest first.
    const after = index === 0 ? current : versions[index - 1];
    const diff = diffFlowDefinitions(row.definition, after.definition, {
      currentName: row.name,
      newName: after.name
    });
    // diffFlowDefinitions always returns at least one line, falling back to
    // its prospective "Nothing would change." That sentence is written for a
    // change being PROPOSED; here the edit already happened, so an equivalent
    // pair reports nothing and the panel says so in its own words. Tested on
    // the diff's fields rather than that string, so rewording it upstream
    // cannot silently turn the sentinel into a real-looking history line.
    const unchanged =
      diff.renamedTo === null &&
      !diff.triggerChanged &&
      diff.stepsAdded.length === 0 &&
      diff.stepsRemoved.length === 0 &&
      diff.stepsChanged.length === 0;
    return {
      versionId: row.id,
      name: row.name,
      replacedAt: row.replaced_at,
      by: describeEditSource(row.source),
      actor: row.actor,
      changeSummary: unchanged ? [] : diff.summary,
      isMostRecent: index === 0
    };
  });
}
