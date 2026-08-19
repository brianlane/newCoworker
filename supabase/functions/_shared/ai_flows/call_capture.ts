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
 * Fields always published under the prefix, "none" when the AI did not get
 * them. Mirrors WAIT_FOR_CALL_CAPTURED_FIELDS in src/lib/ai-flows/schema.ts (the
 * authoring side registers the same names), keep the two in lockstep.
 *
 * "none" rather than absent because that is this codebase's explicit-absence
 * idiom: a template can print the line without a dangling label, and a `when`
 * guard can say `notEquals: "none"` instead of tripping over an unset var that
 * renders as the empty string.
 */
export const ALWAYS_PUBLISHED_CAPTURE_FIELDS = [
  "name",
  "phone",
  "email",
  "address",
  "timeframe",
  "notes"
] as const;

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
 * Build the vars for what a call captured. The standard fields are ALWAYS
 * published ("none" when the AI did not get them) so a team-facing template can
 * print "the seller said X" without a dangling label, and a `when` guard has a
 * real value to test. Anything else the AI captured rides along when non-empty.
 *
 * `capturedSpoken` is what a caller should read to decide whether the AI
 * actually got a value, since "none" here means it did not.
 */
export function capturedCallVars(
  captured: CapturedCall | null | undefined,
  prefix: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of ALWAYS_PUBLISHED_CAPTURE_FIELDS) out[`${prefix}${field}`] = "none";
  if (!captured || typeof captured !== "object") return out;
  for (const [rawKey, rawValue] of Object.entries(captured)) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) continue;
    const suffix = capturedVarSuffix(rawKey);
    if (!suffix) continue;
    out[`${prefix}${suffix}`] = value;
  }
  return out;
}

/** The value the AI actually captured for `field`, or "" when it did not. */
export function capturedSpoken(
  vars: Record<string, string>,
  prefix: string,
  field: string
): string {
  const v = vars[`${prefix}${field}`];
  return typeof v === "string" && v.trim().toLowerCase() !== "none" ? v.trim() : "";
}
