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
   * The ONE lowercase substring the flow branch matches on, and the only
   * thing resolveKinService considers.
   *
   * Deliberately a single token rather than a list: MAX_BRANCH_ARMS is 4, so
   * three services plus the fallback already fills the branch and there is no
   * room for an arm per phrasing. A `when` condition also takes exactly one
   * of equals/contains/notEquals, so one arm cannot OR several aliases. Both
   * halves therefore agree by construction on this token, and anything
   * fuzzier is the coworker's job (see `aliases`).
   */
  flowMatch: string;
  /**
   * Other phrasings a parent might use. NOT matched by the flow: these feed
   * the coworker's prose rules in identity.md, where reading meaning is the
   * whole point. A lead form that says "youth counselling" therefore lands on
   * the general page with a question, and the coworker routes the reply.
   */
  aliases: readonly string[];
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
    // Carries its own age signal. "counselling" is deliberately NOT the
    // token: see the age trap in the module header.
    flowMatch: "teen",
    aliases: ["youth", "adolescent", "14-17", "high school"]
  },
  {
    key: "ot",
    label: "Occupational therapy",
    serviceName: "occupational therapy",
    link: "https://kinintegrated.janeapp.com/#/occupational-therapy",
    // Covers "occupational therapy", "Occupational-Therapy", "occupational
    // therapy assessment". Ahead of psych so an OT assessment stays OT.
    flowMatch: "occupational",
    aliases: ["ot", "sensory", "motor skills", "handwriting", "feeding"]
  },
  {
    key: "psych",
    label: "Psychological assessment",
    serviceName: "psychological assessment",
    link: "https://kinintegrated.janeapp.com/#/psychological-assessment",
    // "psycholog" covers psychological / psychology / psychologist. Bare
    // "assessment" is deliberately NOT the token: OT, speech and psych all
    // do assessments, so it would steal OT enquiries. An unqualified
    // "assessment" is genuinely ambiguous and belongs on the general page
    // with a question, which is the same principle as the age trap.
    flowMatch: "psycholog",
    aliases: ["psychoeducational", "psych-ed", "adhd", "autism", "testing", "school report"]
  }
] as const;

/** Every link the tenant hands out, general last. */
export function allKinBookingLinks(): string[] {
  return [...KIN_BOOKING_SERVICES.map((s) => s.link), KIN_GENERAL_BOOKING_LINK];
}

/**
 * Which service a free-text answer points at, or null for "cannot tell".
 *
 * Considers ONLY `flowMatch`, because this is the reference implementation of
 * what the live flow branch does; a test asserts each arm's condition is
 * exactly this token. Aliases are intentionally excluded: matching them here
 * would make this function claim a routing the flow cannot perform, which is
 * the drift this module exists to prevent.
 */
export function resolveKinService(text: string | null | undefined): KinBookingService | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const service of KIN_BOOKING_SERVICES) {
    if (hay.includes(service.flowMatch)) return service;
  }
  return null;
}
