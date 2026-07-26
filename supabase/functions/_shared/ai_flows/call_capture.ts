/**
 * What the AI got out of the person ON a call, turned into flow vars.
 *
 * A referral partner commonly withholds the customer's phone number until after
 * the call it just bridged, so the conversation is frequently the ONLY source
 * for it: the AI asks the seller directly, the bridge writes what it captured
 * onto the handoff session at teardown (ai_takeover.captured), and a run parked
 * on `wait_for_call` picks it up here.
 *
 * Namespaced by `prefix` on purpose. The partner's own value (when it ever
 * arrives) and the value the seller said out loud can disagree, and the team is
 * shown both labeled by source rather than one silently winning.
 */

/** The bridge writes a flat map of capture-field name to spoken value. */
export type CapturedCall = Record<string, unknown>;

/**
 * Normalize a capture-field name into a legal var suffix. The names come from
 * the voice flow's `captureFields`, which is free text an owner authored
 * ("reason for calling"), so it cannot be trusted to be var-shaped.
 * Returns "" for a name with nothing usable in it.
 */
export function capturedVarSuffix(rawKey: string): string {
  return rawKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Build the vars for what a call captured. Blank values are dropped rather than
 * written as empty strings: an absent var reads as "the AI never got this",
 * which is what a later `when` guard needs to branch on.
 */
export function capturedCallVars(
  captured: CapturedCall | null | undefined,
  prefix: string
): Record<string, string> {
  if (!captured || typeof captured !== "object") return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(captured)) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) continue;
    const suffix = capturedVarSuffix(rawKey);
    if (!suffix) continue;
    out[`${prefix}${suffix}`] = value;
  }
  return out;
}
