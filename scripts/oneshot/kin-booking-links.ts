/**
 * kin-booking-links.ts: KIN Integrated Child Health's JaneApp booking pages
 * and the routing that picks between them.
 *
 * ONE source of truth, imported by both halves of the routing, because the
 * two halves fail differently when they disagree:
 *   - kin-lead-definition.ts, the PROACTIVE half: the first text to a Meta
 *     lead, routed on what the lead form captured.
 *   - kin-knowledge-content.ts, the REACTIVE half: what the SMS coworker
 *     hands out when a lead replies. Kingsley's plan is "text leads with
 *     these links and follow up only if they do not reply. If they reply the
 *     ai worker will nurture", so the coworker must know these or the reply
 *     path dead-ends.
 *
 * ## Why routing is service-first, with age NESTED inside counselling
 *
 * The v1 lead form asked only "what kind of support" and "who is the support
 * for". The v3 form (id 1074533798402620) asks the same two questions with
 * real values: service `counselling` / `occupational_therapy` / `speech_slp`
 * / `psychological_assessment`, and age `child_12_and_under` /
 * `teen_13_to_17` / `adult`.
 *
 * `lead_notes` concatenates BOTH answers, so a flat service-level match on
 * "teen" is hijacked by the AGE field: `occupational_therapy` +
 * `teen_13_to_17` contains "teen", and a 15-year-old needing occupational
 * therapy was routed to counselling. Simulated against v3 before the switch,
 * 5 of 12 combinations mis-routed that way.
 *
 * So the SERVICE decides the discipline, and age only sub-routes WITHIN
 * counselling, which is the only discipline whose page is age-split. That
 * makes the collision structurally impossible rather than merely avoided.
 *
 * ## Ages
 *
 * Kingsley extended the teen page down to 13 on 2026-08-26, which closed the
 * gap James raised (child ended at 12, teen began at 14, so a 13-year-old had
 * no bookable page). The slug changed with it, from
 * `teen-youth-counselling-ages-14-17` to `...-ages-13-17`; the old one is
 * stale and must not be handed out.
 *
 * ## Speech / SLP is a WAITLIST, not a missing page
 *
 * Confirmed by Kingsley 2026-08-26: speech is run as a waitlist, so there is
 * no booking page by design and there never will be one until that changes.
 * Sending such a lead ANY booking link is wrong: the general page invites
 * them to book a service they cannot book. The speech arm therefore sends no
 * link at all, says plainly that it is a waitlist, and leans on the owner
 * alert that every lead already triggers so the clinic can add them.
 *
 * He also said the current ads are not running SLP yet, so this arm is
 * dormant until James turns that on. Built now rather than remembered later.
 *
 * Couples counselling has a page but the form cannot produce that answer, so
 * it is coworker-only knowledge.
 */

export type KinBookingService = {
  /** Step-id and branch-arm suffix. */
  key: string;
  /** Owner-facing arm label. */
  label: string;
  /** Customer-facing service name, used in copy. */
  serviceName: string;
  /** JaneApp booking URL. */
  link: string;
  /**
   * The ONE lowercase substring the flow branch matches on.
   *
   * Single token, not a list: `MAX_BRANCH_ARMS` is 4, and a `when` condition
   * takes exactly one of equals/contains/notEquals, so an arm cannot OR
   * several phrasings. Both halves therefore agree by construction, and a
   * test asserts the live arm conditions equal these exact strings.
   */
  flowMatch: string;
  /** Other phrasings, for the coworker's prose only. Never matched by the flow. */
  aliases: readonly string[];
  /**
   * True when the service cannot be booked online at all and the clinic runs
   * a waitlist instead. `link` is then a placeholder and MUST NOT be sent:
   * offering a booking page for a waitlist-only service is a promise the
   * business has not authorized.
   */
  waitlist?: boolean;
};

/** Where a lead goes when we cannot tell what they need. */
export const KIN_GENERAL_BOOKING_LINK = "https://kinintegrated.janeapp.com/";

/**
 * Disciplines, matched on the SERVICE answer. Counselling is last because it
 * is the one that then sub-routes on age; the other two are terminal.
 */
export const KIN_BOOKING_SERVICES: readonly KinBookingService[] = [
  {
    key: "ot",
    label: "Occupational therapy",
    serviceName: "occupational therapy",
    link: "https://kinintegrated.janeapp.com/#/occupational-therapy",
    // Covers "occupational_therapy", "Occupational Therapy" and
    // "occupational therapy assessment", which stays OT rather than psych.
    flowMatch: "occupational",
    aliases: ["ot", "sensory", "motor skills", "handwriting", "feeding"]
  },
  {
    key: "psych",
    label: "Psychological assessment",
    serviceName: "psychological assessment",
    link: "https://kinintegrated.janeapp.com/#/psychological-assessment",
    // "psycholog" covers psychological / psychology / psychologist. Bare
    // "assessment" is deliberately NOT the token: OT, speech and psychology
    // all run assessments, so it would steal OT inquiries.
    flowMatch: "psycholog",
    aliases: ["psychoeducational", "psych-ed", "adhd", "autism", "testing", "school report"]
  },
  {
    key: "speech",
    label: "Speech / SLP (waitlist)",
    serviceName: "speech and language therapy",
    // Placeholder, never sent: see `waitlist`.
    link: KIN_GENERAL_BOOKING_LINK,
    // Covers "speech_slp", "Speech / SLP" and "speech therapy". No other
    // form value or age key contains "speech".
    flowMatch: "speech",
    aliases: ["slp", "language", "stutter", "articulation", "myofascial", "tongue tie"],
    waitlist: true
  },
  {
    key: "counselling",
    label: "Counselling (age decides the page)",
    serviceName: "counselling",
    // Never sent directly: the nested age branch picks one of the pages in
    // KIN_COUNSELLING_AGES. Present so the general page is the honest
    // fallback when the age answer is missing.
    link: KIN_GENERAL_BOOKING_LINK,
    flowMatch: "counselling",
    aliases: ["therapy", "counseling", "talk to someone", "mental health"]
  }
] as const;

export type KinCounsellingAge = {
  key: string;
  label: string;
  serviceName: string;
  link: string;
  flowMatch: string;
  aliases: readonly string[];
};

/**
 * Counselling pages by age. Matched INSIDE the counselling arm only, so an
 * age word can never decide a non-counselling discipline.
 *
 * Tokens deliberately work for BOTH form versions while the ads switch over:
 * v1 sent labels ("My child (12 and under)"), v3 sends keys
 * ("child_12_and_under"); "child", "teen" and "adult" appear in both.
 */
export const KIN_COUNSELLING_AGES: readonly KinCounsellingAge[] = [
  {
    key: "child",
    label: "Child counselling (3-12)",
    serviceName: "child counselling",
    link: "https://kinintegrated.janeapp.com/#/child-counselling-ages-3-12",
    flowMatch: "child",
    aliases: ["kid", "little one", "toddler", "primary school", "elementary"]
  },
  {
    key: "teen",
    label: "Teen and youth counselling (13-17)",
    serviceName: "teen and youth counselling",
    // 13-17 since 2026-08-26. The old ...-ages-14-17 slug is stale.
    link: "https://kinintegrated.janeapp.com/#/teen-youth-counselling-ages-13-17",
    flowMatch: "teen",
    aliases: ["youth", "adolescent", "high school", "13", "14", "15", "16", "17"]
  },
  {
    key: "adult",
    label: "Adult counselling",
    serviceName: "adult counselling",
    link: "https://kinintegrated.janeapp.com/#/adult-counselling",
    flowMatch: "adult",
    aliases: ["myself", "me", "grown up", "parent"]
  }
] as const;

/**
 * Couples counselling exists on the booking site but the lead form cannot
 * produce that answer, so it is coworker knowledge only, never a flow arm.
 */
export const KIN_COUPLES_BOOKING_LINK = "https://kinintegrated.janeapp.com/#/couples-counselling";

/**
 * Every page the tenant hands out, general last.
 *
 * Includes couples even though no flow arm can reach it: the coworker-side
 * drift guard loops this list against identity.md, so anything missing here
 * is a page that could silently disappear from the coworker's knowledge.
 */
export function allKinBookingLinks(): string[] {
  return [
    ...KIN_BOOKING_SERVICES.filter((s) => s.link !== KIN_GENERAL_BOOKING_LINK).map((s) => s.link),
    ...KIN_COUNSELLING_AGES.map((a) => a.link),
    KIN_COUPLES_BOOKING_LINK,
    KIN_GENERAL_BOOKING_LINK
  ];
}

/**
 * Which discipline a free-text answer names, or null for "cannot tell".
 * Considers ONLY `flowMatch`, mirroring exactly what the live branch does.
 */
export function resolveKinService(text: string | null | undefined): KinBookingService | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const service of KIN_BOOKING_SERVICES) {
    if (hay.includes(service.flowMatch)) return service;
  }
  return null;
}

/** Which counselling age page an answer names, or null. Counselling only. */
export function resolveKinCounsellingAge(
  text: string | null | undefined
): KinCounsellingAge | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const age of KIN_COUNSELLING_AGES) {
    if (hay.includes(age.flowMatch)) return age;
  }
  return null;
}

/**
 * What a lead should receive. Deliberately not a bare string: "book here" and
 * "we will add you to the waitlist" are different outcomes, and collapsing
 * them into a URL is how a waitlist-only service ends up with a booking link.
 */
export type KinBookingOutcome =
  | { kind: "link"; url: string }
  | { kind: "waitlist"; service: KinBookingService };

/**
 * Reference implementation of the live branch: service first, then age
 * within counselling, then the general page.
 */
export function resolveKinBooking(notes: string | null | undefined): KinBookingOutcome {
  const service = resolveKinService(notes);
  if (!service) return { kind: "link", url: KIN_GENERAL_BOOKING_LINK };
  if (service.waitlist) return { kind: "waitlist", service };
  if (service.key !== "counselling") return { kind: "link", url: service.link };
  const age = resolveKinCounsellingAge(notes);
  return { kind: "link", url: age?.link ?? KIN_GENERAL_BOOKING_LINK };
}
