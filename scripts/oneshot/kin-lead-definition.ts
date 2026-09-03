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
 *   s_extract / s_file / s_notify_new   Kingsley hears about the lead at
 *                                       once. notify_owner sits BEFORE the
 *                                       greeting because quiet hours defer
 *                                       the run at the first gated step; put
 *                                       the greeting first and an overnight
 *                                       lead delays the owner alert too.
 *   s_route_booking                     Names the clinic, thanks them for the
 *                                       consult request, and hands them the
 *                                       booking page for the discipline the
 *                                       lead form named (teen counselling,
 *                                       psychological assessment, or OT),
 *                                       falling back to the general page with
 *                                       a "tell me which" prompt. Routing
 *                                       table: kin-booking-links.ts.
 *                                       Speed-to-lead: the SMS IS the
 *                                       delivery of the link, so there is no
 *                                       self-book sleep window here.
 *   nudges at 2h and next-day           The cadence Kingsley chose on the
 *                                       intake (first_follow_up 2h,
 *                                       second_follow_up next_day, handoff
 *                                       after 2 attempts).
 *   s_flag_owner / s_mark_inactive      Handoff after the second unanswered
 *                                       nudge, lead tagged Inactive.
 *   s_goal (LAST)                       replied / appointment_booked.
 *
 * A parked wait_for_reply captures a real reply so later no_reply nudges
 * skip. It does not mute the SMS coworker: this flow does not set
 * suppressDefaultReply, so a lead who texts back is handed to the coworker
 * (Kingsley's "if they reply the ai worker will nurture"). That split
 * shipped 2026-09-03 after a booked-but-unsure reply was swallowed.
 *
 * KNOWN LIMIT, recorded in docs/tenants/kin-integrated-child-health.md:
 * JaneApp has no integration, so nothing can observe a booking. The
 * `appointment_booked` goal and the booking precheck are inert, and a lead
 * who books but never replies still gets both nudges. Nudge 2 therefore
 * carries "If you already booked, you are all set" so the worst case reads
 * as polite rather than broken.
 */

import {
  KIN_BOOKING_SERVICES,
  KIN_COUNSELLING_AGES,
  KIN_GENERAL_BOOKING_LINK,
  type KinBookingService,
  type KinCounsellingAge
} from "./kin-booking-links.ts";

export const KIN_FLOW_NAME = "Lead follow-up (white-glove build)";

/**
 * Sentinel that stood in for the booking link while it was outstanding.
 * Kept because patch-kin-lead-flow.ts still refuses to --apply whenever the
 * link reads as pending; the guard costs nothing and protects the next
 * person who copies this file for another tenant.
 */
export const KIN_JANEAPP_LINK_PENDING = "<JANEAPP_BOOKING_LINK_PENDING>";

/**
 * The GENERAL JaneApp page, used when the lead form did not tell us which
 * discipline they need. Service-specific links live in kin-booking-links.ts
 * and are chosen by the s_route_booking branch. Received from Kingsley
 * 2026-08-25.
 */
export const KIN_JANEAPP_BOOKING_LINK: string = KIN_GENERAL_BOOKING_LINK;

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
/**
 * The one waitlist-only service, resolved once so the greeting arm and the
 * nudge gate cannot disagree about which lead skips the cascade.
 */
const WAITLIST_SERVICE = KIN_BOOKING_SERVICES.find((x) => x.waitlist)!;

export function buildKinLeadDefinition(
  bookingLink: string = KIN_JANEAPP_BOOKING_LINK
): { version: number; trigger: Record<string, unknown>; steps: FlowStepJson[] } {
  // A link followed immediately by a period gets swallowed into the URL by
  // the shortener's matcher (https?://[^\s<>"']+), and JaneApp 404s on the
  // trailing dot. Every link here therefore ends its line.
  const greetFor = (
    what: KinBookingService | KinCounsellingAge | null,
    askAge = false
  ): string => {
    const opening =
      "Hi {{vars.lead_name}}, this is the assistant for KIN Integrated Child Health. " +
      "Thanks for requesting your free 15 minute consult.";
    // A waitlist-only service gets NO link: the general page would invite a
    // booking that cannot be made. The owner alert every lead already fires
    // is what gets them onto the list.
    if (what && "waitlist" in what && what.waitlist) {
      // serviceName is written for mid-sentence use ("book your occupational
      // therapy consult"), so it needs a capital when it opens one.
      const opener = what.serviceName.charAt(0).toUpperCase() + what.serviceName.slice(1);
      return (
        `${opening} ${opener} is running on a waitlist right now rather than ` +
        "open booking, so I have let the team know and someone will be in touch about a spot. " +
        "If you would like help with anything else in the meantime, just reply here."
      );
    }
    if (what) {
      return (
        `${opening} You can book your ${what.serviceName} consult right here:\n` +
        `${what.link}\n` +
        "Or reply here with any questions and I will help."
      );
    }
    if (askAge) {
      // Counselling with no usable age answer. The pages are age-split, so
      // guessing one books them into a service that will turn them away.
      return (
        `${opening} You can pick a time here:\n` +
        `${bookingLink}\n` +
        "So I can point you at the right counsellor, is this for a child, a teenager, " +
        "or an adult?"
      );
    }
    return (
      `${opening} You can pick a time here:\n` +
      `${bookingLink}\n` +
      "If you tell me what you are looking for, occupational therapy, counselling, speech, " +
      "or a psychological assessment, I will send you the right booking page and answer " +
      "any questions."
    );
  };

  const nudge1 =
    "Hi {{vars.lead_name}}, just floating this back up. Whenever you are ready, " +
    "you can book your free consult here:\n" +
    `${bookingLink}\n` +
    "and I am happy to answer any questions here.";

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
        // BEFORE s_greet, load-bearing: quiet hours defer the whole run at
        // the first gated step, so an overnight lead parked on the greeting
        // would also park the owner alert until 09:00. Notify first means
        // Kingsley hears about every lead the moment it lands, and only the
        // lead-facing text waits for morning. Same ordering as Scar Fairy.
        id: "s_notify_new",
        type: "notify_owner",
        // Deliberately does NOT say what the lead was sent: this fires BEFORE
        // the routing branch (quiet hours would otherwise delay the alert
        // too), so it cannot know, and speech leads receive no link at all.
        // The Details line carries the service they asked for, which is what
        // tells Kingsley a speech request needs adding to the waitlist.
        message:
          "New lead: {{vars.lead_name}}, {{vars.lead_phone}} / {{vars.lead_email}}. Details: {{vars.lead_notes}}. I'm replying now with their next step (overnight leads get their text from 9am) and I'm on follow-up duty."
      },
      {
        // SERVICE decides the discipline; age only sub-routes inside
        // counselling. Flat matching on an age word was hijacked by the v3
        // form, where `teen_13_to_17` made an occupational-therapy lead
        // route to counselling. Deterministic throughout, no model call.
        id: "s_route_booking",
        type: "branch",
        question: "Which discipline does this lead need",
        branches: KIN_BOOKING_SERVICES.map((service) => ({
          id: `arm_${service.key}`,
          label: service.label,
          condition: {
            var: "lead_notes",
            contains: service.flowMatch,
            caseInsensitive: true
          },
          steps:
            service.key === "counselling"
              ? [
                  {
                    // Counselling is the only age-split discipline, so its
                    // page is chosen here rather than by the service answer.
                    id: "s_route_age",
                    type: "branch",
                    question: "Which counselling age group",
                    branches: KIN_COUNSELLING_AGES.map((age) => ({
                      id: `arm_age_${age.key}`,
                      label: age.label,
                      condition: {
                        var: "lead_notes",
                        contains: age.flowMatch,
                        caseInsensitive: true
                      },
                      steps: [
                        {
                          id: `s_greet_age_${age.key}`,
                          type: "send_sms",
                          to: "{{vars.lead_phone}}",
                          body: greetFor(age),
                          quietHours: { ...KIN_QUIET_HOURS }
                        }
                      ]
                    })),
                    else: [
                      {
                        id: "s_greet_counselling_unknown_age",
                        type: "send_sms",
                        to: "{{vars.lead_phone}}",
                        body: greetFor(null, true),
                        quietHours: { ...KIN_QUIET_HOURS }
                      }
                    ]
                  }
                ]
              : [
                  {
                    id: `s_greet_${service.key}`,
                    type: "send_sms",
                    to: "{{vars.lead_phone}}",
                    body: greetFor(service),
                    quietHours: { ...KIN_QUIET_HOURS }
                  }
                ]
        })),
        // Speech/SLP (no booking page exists) and anything unrecognized.
        else: [
          {
            id: "s_greet_general",
            type: "send_sms",
            to: "{{vars.lead_phone}}",
            body: greetFor(null),
            quietHours: { ...KIN_QUIET_HOURS }
          }
        ]
      },
      {
        // The nudge cascade is shared, and every step in it is booking copy
        // carrying the general link. A waitlist lead must never reach it:
        // sending "book your free consult here" two hours after telling them
        // there is nothing to book would undo the whole waitlist rule.
        //
        // `contains` has no negation, so the waitlist arm holds the cascade's
        // ABSENCE and the else holds the cascade itself.
        id: "s_followups",
        type: "branch",
        question: "Should this lead get the booking nudge cascade",
        branches: [
          {
            id: "arm_no_nudges_waitlist",
            label: "Waitlist lead, no booking nudges",
            condition: {
              var: "lead_notes",
              contains: WAITLIST_SERVICE.flowMatch,
              caseInsensitive: true
            },
            // Intentionally empty: they have their answer and the team has
            // been alerted. There is nothing to nudge them toward.
            steps: []
          }
        ],
        else: [
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
        ]
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
