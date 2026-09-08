/**
 * What kind of lead this contact is (buyer / seller / both).
 *
 * Used to narrow unowned-lead claim alerts to the teammates whose roster
 * tags cover that type. The model-facing `notify_team` tool may omit the
 * type, so the resolver looks it up from stored facts instead of paging
 * everyone. Fail-safe lives with the caller: this module returns null when
 * nothing is stored or the sources disagree, and the broadcast then widens
 * to every eligible teammate rather than going silent.
 *
 * `route_lead_type` is a REACHABILITY gate on some flows (it answers "none"
 * when the lead has no phone option). It is only treated as a type when it
 * is already buyer/seller/both.
 */

export const LEAD_TYPES = ["buyer", "seller", "both"] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

const LEAD_TYPE_SET = new Set<string>(LEAD_TYPES);

/** Cadence writers append `lead_type: seller` to the contact note. */
const LEAD_TYPE_NOTE_RE = /\blead_type:\s*(buyer|seller|both)\b/i;

/** buyer / seller / both, else null. "none" and typos are not types. */
export function normalizeLeadType(raw: unknown): LeadType | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return LEAD_TYPE_SET.has(value) ? (value as LeadType) : null;
}

/** Read `lead_type: seller` (any casing) out of a contact note or trigger blob. */
export function leadTypeFromText(text: string | null | undefined): LeadType | null {
  if (!text) return null;
  const match = LEAD_TYPE_NOTE_RE.exec(text);
  return match ? normalizeLeadType(match[1]) : null;
}

/**
 * One run's stored type. Prefers `vars.lead_type`, then a real
 * `route_lead_type`, then a `lead_type:` line anywhere in the context blob
 * (the tag-changed event note the cadence writers append).
 */
export function leadTypeFromRunContext(context: unknown): LeadType | null {
  const ctx =
    context && typeof context === "object" ? (context as Record<string, unknown>) : null;
  const vars =
    ctx?.vars && typeof ctx.vars === "object" ? (ctx.vars as Record<string, unknown>) : {};
  const fromLead = normalizeLeadType(vars.lead_type);
  if (fromLead) return fromLead;
  const fromRoute = normalizeLeadType(vars.route_lead_type);
  if (fromRoute) return fromRoute;
  return leadTypeFromText(JSON.stringify(context ?? ""));
}

/**
 * Agree on one type, or null. Empty and conflicting both fail open: the
 * caller pages everyone eligible rather than guessing.
 */
export function decideInferredLeadType(found: readonly (LeadType | null)[]): LeadType | null {
  const distinct = [...new Set(found.filter((t): t is LeadType => t !== null))];
  return distinct.length === 1 ? distinct[0] : null;
}
