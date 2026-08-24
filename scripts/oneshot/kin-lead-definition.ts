/**
 * kin-lead-definition.ts: the canonical KIN Integrated Child Health "Lead
 * follow-up (white-glove build)" flow definition, extracted as a pure builder
 * (same split as scar-fairy-lead-definition.ts) so
 * tests/oneshot-kin-definitions.test.ts can pin it without executing a CLI.
 *
 * Why this exists: the white-glove apply installed the generic template with
 * the intake's greeting pasted verbatim, typos and all ("on you healing
 * journey", "l'll" with a lowercase L), no business name in the first text,
 * and no way for the lead to actually book. Kingsley's model is a JaneApp
 * booking LINK handed to the lead (the same handoff James ran before Calendly
 * allowed two app integrations), not a calendar integration.
 *
 * Shape, and why:
 *
 *   s_extract / s_file / s_notify_new   Kingsley hears about the lead at once
 *                                       (notify_owner has no quiet hours on
 *                                       purpose; only lead-facing texts wait).
 *   s_greet                             Names the clinic, thanks them for the
 *                                       consult request, hands them the
 *                                       JaneApp link. Speed-to-lead: the SMS
 *                                       IS the delivery of the link, so there
 *                                       is no self-book sleep window here.
 *   nudges at 2h and next-day           The cadence Kingsley chose on the
 *                                       intake (first_follow_up 2h,
 *                                       second_follow_up next_day, handoff
 *                                       after 2 attempts).
 *   s_flag_owner / s_mark_inactive      Handoff after the second unanswered
 *                                       nudge, lead tagged Inactive.
 *   s_goal (LAST)                       replied / appointment_booked.
 *
 * KNOWN LIMIT, recorded in docs/tenants/kin-integrated-child-health.md:
 * JaneApp has no integration, so nothing can observe a booking. The
 * `appointment_booked` goal and the booking precheck are inert, and a lead
 * who books but never replies still gets both nudges. Nudge 2 therefore
 * carries "If you already booked, you are all set" so the worst case reads
 * as polite rather than broken.
 */

export const KIN_FLOW_NAME = "Lead follow-up (white-glove build)";

/**
 * Sentinel standing in for Kingsley's real JaneApp booking link, still
 * outstanding (Brian is collecting it). patch-kin-lead-flow.ts REFUSES to
 * --apply while this constant still reads the placeholder, so it can never
 * reach a lead's phone. Landing the real link is a one-line diff + a re-run.
 */
export const KIN_JANEAPP_LINK_PENDING = "<JANEAPP_BOOKING_LINK_PENDING>";

/** Kingsley's JaneApp booking link for the free 15 minute consult. */
export const KIN_JANEAPP_BOOKING_LINK: string = KIN_JANEAPP_LINK_PENDING;

/** True while the booking link is still the placeholder. */
export function bookingLinkIsPending(link: string = KIN_JANEAPP_BOOKING_LINK): boolean {
  return link === KIN_JANEAPP_LINK_PENDING;
}

/**
 * Lead-facing SMS window. Owner alerts stay instant; only texts to the lead
 * hold. 09:00-20:00 Edmonton: the clinic's stated hours are Mon-Fri 9-6, but
 * parents fill in ad forms in the evening, and a first touch at 7pm is the
 * difference between a warm lead and a cold one. Past 8pm waits for morning.
 */
export const KIN_QUIET_HOURS = {
  timezone: "America/Edmonton",
  noSendAfter: "20:00",
  resumeAt: "09:00"
} as const;

/** Intake cadence: first follow-up after 2 hours, second the next day. */
export const KIN_FIRST_FOLLOW_UP_MINUTES = 120;
export const KIN_SECOND_FOLLOW_UP_MINUTES = 1440;

type FlowStepJson = Record<string, unknown>;

/**
 * Build the full definition. `bookingLink` defaults to the module constant so
 * the applier and the tests exercise exactly what would ship.
 */
export function buildKinLeadDefinition(
  bookingLink: string = KIN_JANEAPP_BOOKING_LINK
): { version: number; trigger: Record<string, unknown>; steps: FlowStepJson[] } {
  const greet =
    "Hi {{vars.lead_name}}, this is the assistant for KIN Integrated Child Health. " +
    "Thanks for requesting your free 15 minute consult. We want to get you started " +
    "on your healing journey soon. Pick a time for your consultation call here: " +
    `${bookingLink} . Or reply here with any questions and I will help.`;

  const nudge1 =
    "Hi {{vars.lead_name}}, just floating this back up. Whenever you are ready, " +
    `the booking link for your free consult is ${bookingLink} , and I am happy ` +
    "to answer any questions here.";

  const nudge2 =
    "Hi {{vars.lead_name}}, I do not want you to slip through the cracks. Want " +
    "help getting your consultation scheduled? If you already booked, you are " +
    "all set, no need to reply.";

  return {
    version: 1,
    // Single-arm on purpose: today the only webhook feed is James's Zapier
    // bridge relaying the one Meta form, so every authenticated lead event
    // should run this nurture. Add form_name conditions if a second form
    // with different handling ever lands (see Scar Fairy's bundle routing).
    trigger: { channel: "webhook", conditions: [] },
    steps: [
      {
        id: "s_extract",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "The lead's full name" },
          { name: "lead_phone", description: "The lead's phone number, digits and + only" },
          { name: "lead_email", description: "The lead's email address" },
          {
            name: "lead_notes",
            description:
              "Everything else the lead provided: custom question answers, city, budget, timeframe. 'none' if nothing."
          }
        ]
      },
      {
        id: "s_file",
        type: "upsert_customer",
        nameVar: "lead_name",
        emailVar: "lead_email",
        phoneVar: "lead_phone"
      },
      {
        id: "s_greet",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: greet,
        quietHours: { ...KIN_QUIET_HOURS }
      },
      {
        id: "s_notify_new",
        type: "notify_owner",
        message:
          "New lead: {{vars.lead_name}}, {{vars.lead_phone}} / {{vars.lead_email}}. Details: {{vars.lead_notes}}. I sent them the consult booking link and I'm on follow-up duty."
      },
      {
        id: "s_wait_1",
        type: "wait_for_reply",
        saveAs: "reply_1",
        phoneVar: "lead_phone",
        timeoutMinutes: KIN_FIRST_FOLLOW_UP_MINUTES
      },
      {
        id: "s_nudge_1",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: nudge1,
        when: { var: "reply_1", equals: "no_reply" },
        quietHours: { ...KIN_QUIET_HOURS }
      },
      {
        id: "s_wait_2",
        type: "wait_for_reply",
        when: { var: "reply_1", equals: "no_reply" },
        saveAs: "reply_2",
        phoneVar: "lead_phone",
        timeoutMinutes: KIN_SECOND_FOLLOW_UP_MINUTES
      },
      {
        id: "s_nudge_2",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: nudge2,
        when: { var: "reply_2", equals: "no_reply" },
        quietHours: { ...KIN_QUIET_HOURS }
      },
      {
        id: "s_wait_final",
        type: "wait_for_reply",
        when: { var: "reply_2", equals: "no_reply" },
        saveAs: "reply_final",
        phoneVar: "lead_phone",
        timeoutMinutes: KIN_SECOND_FOLLOW_UP_MINUTES
      },
      {
        id: "s_flag_owner",
        type: "notify_owner",
        when: { var: "reply_final", equals: "no_reply" },
        message:
          "Personal touch needed: {{vars.lead_name}} ({{vars.lead_phone}}) hasn't replied to 2 follow-ups. I've marked them Inactive, they're never deleted, and if they reply later the conversation picks right back up."
      },
      {
        id: "s_mark_inactive",
        type: "update_contact",
        when: { var: "reply_final", equals: "no_reply" },
        addTags: ["Inactive"],
        phoneVar: "lead_phone"
      },
      {
        id: "s_goal",
        type: "goal",
        label: "Lead replied or booked",
        events: [{ kind: "replied" }, { kind: "appointment_booked" }]
      }
    ]
  };
}
