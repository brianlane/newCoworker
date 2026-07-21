/**
 * kyp-noshow-definition.ts — the canonical KYP Ads "No-show recovery text"
 * flow definition, applied to the live tenant by patch-kyp-noshow-links.ts.
 *
 * Incident (Jul 20 2026, Tim Tsai): the flow hardcoded the $200 booking link
 * (kyp-ads-free-strategy-2) for EVERY no-show — Tim, a $100/week lead who
 * had booked through my-free-scale-plan, got the $200 event's link in his
 * recovery text. tests/oneshot-kyp-noshow-definition.test.ts pins the
 * routing by booked event type.
 *
 * Event-type display names (verified against Calendly's public booking API,
 * Jul 20 2026):
 *   - my-free-scale-plan       → "KYP Ads | Free Strategy Call"       ($100/week)
 *   - kyp-ads-free-strategy-2  → "KYP Ads | Free Strategy Call | 2"   ($200/week)
 */

export const KYP_NOSHOW_FLOW_NAME =
  "No-show recovery text — mark no-shows in Calendly within 2h; awaiting approval";

export const KYP_NOSHOW_LINK_100 = "https://calendly.com/james-kyp-ads/my-free-scale-plan";
export const KYP_NOSHOW_LINK_200 = "https://calendly.com/james-kyp-ads/kyp-ads-free-strategy-2";

type FlowStepJson = Record<string, unknown>;

/** The recovery text, offering the SAME event type the lead no-showed. */
function recoveryText(id: string, bookingLink: string): FlowStepJson {
  return {
    id,
    type: "send_sms",
    to: "{{vars.invitee_phone}}",
    body:
      "Hey {{vars.invitee_first_name}}, sorry we missed each other! Want to grab another time? " +
      bookingLink,
    when: { var: "invitee_phone", notEquals: "none" }
  };
}

export function buildKypNoShowDefinition(): Record<string, unknown> {
  const steps: FlowStepJson[] = [
    {
      id: "extract_invitee",
      type: "extract_text",
      fields: [
        {
          name: "invitee_first_name",
          description: "The invitee's FIRST name only, from the 'invitee name:' line."
        },
        {
          name: "invitee_phone",
          description:
            "The invitee's phone number from the 'invitee phone:' line, digits and + only. 'none' when absent."
        },
        {
          name: "event_title",
          description: "The event title from the 'title:' line, verbatim."
        }
      ]
    },
    {
      // Route by which event type was no-showed, so the rebooking link is
      // always the SAME offer the lead originally booked. Arms are checked
      // top to bottom, so the "| 2" match must precede the plain one (both
      // titles contain "Free Strategy Call"). An unrecognized title texts
      // the lead NOTHING — a future event type must never leak either rate.
      id: "route_recovery",
      type: "branch",
      question: "Which event type was no-showed?",
      branches: [
        {
          id: "arm_200",
          label: "$200/week (Free Strategy Call | 2)",
          condition: { var: "event_title", contains: "free strategy call | 2", caseInsensitive: true },
          steps: [recoveryText("recovery_text_200", KYP_NOSHOW_LINK_200)]
        },
        {
          id: "arm_100",
          label: "$100/week (Free Strategy Call)",
          condition: { var: "event_title", contains: "free strategy call", caseInsensitive: true },
          steps: [recoveryText("recovery_text_100", KYP_NOSHOW_LINK_100)]
        }
      ],
      else: [
        {
          id: "flag_unknown_event",
          type: "notify_owner",
          message:
            "No-show for an event type I don't recognize: \"{{vars.event_title}}\" — " +
            "{{vars.invitee_first_name}} ({{vars.invitee_phone}}). I didn't text them a " +
            "rebooking link (I can't tell which offer they booked); follow up personally."
        }
      ]
    }
  ];

  return {
    version: 1,
    trigger: {
      on: "event_end",
      channel: "calendar",
      calendar: "primary",
      conditions: [{ type: "contains", value: "invitee no-show: yes", caseInsensitive: true }],
      followMinutes: 120
    },
    timeWindow: { timezone: "America/Toronto", start: "11:00", end: "18:00" },
    steps
  };
}
