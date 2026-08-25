/**
 * kin-booking-links.ts: KIN Integrated Child Health's JaneApp booking links
 * and the service routing that picks between them.
 *
 * ONE source of truth, imported by both halves of the routing, because the
 * two halves fail differently when they disagree:
 *   - kin-lead-definition.ts, the PROACTIVE half. The first text to a Meta
 *     lead, routed on whatever the lead form captured.
 *   - kin-knowledge-content.ts, the REACTIVE half. What the SMS coworker
 *     hands out when a lead replies "it's for OT". Kingsley's stated plan is
 *     "text leads with these links and follow up only if they do not reply.
 *     If they reply the ai worker will nurture", so the coworker MUST know
 *     these links or the reply path dead-ends.
 *
 * Links as Kingsley sent them 2026-08-25 (3 specific, 1 general).
 *
 * THE AGE TRAP, and why `teen` is not simply "counselling": the teen link is
 * scoped to ages 14-17 in JaneApp itself. KIN is a paediatric clinic, so most
 * counselling enquiries are about children YOUNGER than that. Sending a
 * 7-year-old's parent the 14-17 booking page is a wrong booking, not a near
 * miss, so the teen arm requires an explicit teen/youth signal and plain
 * "counselling" falls through to the general link.
 *
 * Services with no dedicated link (speech/SLP, behaviour consulting,
 * counselling outside 14-17, nurse practitioner) intentionally route to the
 * general page, which lists every discipline.
 */

export type KinBookingService = {
  /** Step-id and branch-arm suffix. */
  key: string;
  /** Owner-facing arm label. */
  label: string;
  /** Customer-facing service name, used in copy. */
  serviceName: string;
  /** JaneApp booking URL for this service. */
  link: string;
  /**
   * Lowercase substrings that identify this service in whatever the Meta lead
   * form captured. Matched against the extracted lead notes.
   */
  matches: readonly string[];
};

/** Where a lead goes when we cannot tell which discipline they need. */
export const KIN_GENERAL_BOOKING_LINK = "https://kinintegrated.janeapp.com/";

/**
 * Ordered: the FIRST match wins, so the most specific signal is listed first.
 * "teen" precedes counselling-ish wording deliberately (see the age trap).
 */
export const KIN_BOOKING_SERVICES: readonly KinBookingService[] = [
  {
    key: "teen",
    label: "Teen / youth counselling (14-17)",
    serviceName: "teen and youth counselling",
    link: "https://kinintegrated.janeapp.com/#/teen-youth-counselling-ages-14-17",
    // Every match here carries its own age signal. "counselling" alone is
    // deliberately absent: see the age trap in the module header.
    matches: ["teen", "youth", "adolescent", "14-17", "14 - 17"]
  },
  {
    key: "psych",
    label: "Psychological assessment",
    serviceName: "psychological assessment",
    link: "https://kinintegrated.janeapp.com/#/psychological-assessment",
    matches: ["psychological assessment", "psych assessment", "psychoeducational", "assessment"]
  },
  {
    key: "ot",
    label: "Occupational therapy",
    serviceName: "occupational therapy",
    link: "https://kinintegrated.janeapp.com/#/occupational-therapy",
    // " ot " with spaces would miss "OT" at the start or end of an answer,
    // and bare "ot" would match "robot"; the branch condition is a substring
    // test, so the abbreviation is handled by the coworker side instead.
    matches: ["occupational therapy", "occupational-therapy"]
  }
] as const;

/** Every link the tenant hands out, general last. */
export function allKinBookingLinks(): string[] {
  return [...KIN_BOOKING_SERVICES.map((s) => s.link), KIN_GENERAL_BOOKING_LINK];
}

/**
 * Which service a free-text answer points at, or null for "cannot tell".
 * Pure and deterministic, no model call: the flow branch mirrors this exact
 * ordering, and tests pin the two together.
 */
export function resolveKinService(text: string | null | undefined): KinBookingService | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const service of KIN_BOOKING_SERVICES) {
    if (service.matches.some((m) => hay.includes(m))) return service;
  }
  return null;
}
