/**
 * kyp-offer-definition.ts — the canonical KYP Ads "Lead follow-up
 * (white-glove build)" flow definition, extracted from
 * patch-kyp-offer-branch.ts so tests can import the pure builder without
 * executing the script's CLI body.
 *
 * Any change to KYP's live flow shape belongs HERE (and is re-applied with
 * patch-kyp-offer-branch.ts) — tests/oneshot-kyp-definitions.test.ts pins
 * the invariants that have bitten in production (2 AM nudges, Jul 19 2026).
 */

export const KYP_FLOW_NAME = "Lead follow-up (white-glove build)";

export const KYP_LINK_100 = "calendly.com/james-kyp-ads/my-free-scale-plan";
export const KYP_LINK_200 = "https://calendly.com/james-kyp-ads/kyp-ads-free-strategy-2";

/**
 * KYP's business hours per the white-glove build notes
 * (PRDs/white-glove-build-kyp-ads.md §1: "Business hours: 11am to 6pm";
 * businesses.timezone = America/Toronto). Every follow-up NUDGE carries this
 * send_sms quietHours gate so a midnight lead's 120/1440-minute wait
 * timeouts defer to 11 AM instead of texting at 2 AM (the Jul 19 2026
 * incident). The GREETING deliberately stays ungated — the build notes
 * promise the first touch within 60 seconds of a new lead, any hour.
 */
export const KYP_QUIET_HOURS = {
  timezone: "America/Toronto",
  noSendAfter: "18:00",
  resumeAt: "11:00"
} as const;

/** Flow-level business-hours window for KYP's OTHER flows (same hours). */
export const KYP_TIME_WINDOW = {
  timezone: "America/Toronto",
  start: "11:00",
  end: "18:00"
} as const;

const GREETING_BASE =
  "Hey {{vars.lead_name}}, thanks for your interest in KYP Ads! I saw you're in {{vars.lead_industry}} " +
  "and looking to grow your leads. I'd love to map out a plan for your business on a quick free strategy call. " +
  "You can grab a time here: ";

function nudgeBody(attempt: number, bookingLink: string): string {
  if (attempt === 1) {
    return (
      "Hey {{vars.lead_name}}, just floating this back up — happy to answer any questions whenever you're ready. " +
      `You can grab a time here: ${bookingLink}`
    );
  }
  if (attempt === 2) {
    return (
      "Hi {{vars.lead_name}}, I don't want you to slip through the cracks! " +
      `Booking only takes a minute: ${bookingLink}`
    );
  }
  return (
    "Hey {{vars.lead_name}}, still here whenever you're ready — grab a time that works: " + bookingLink
  );
}

type FlowStepJson = Record<string, unknown>;

function offerArmSteps(prefix: string, bookingLink: string, offerLabel: string): FlowStepJson[] {
  const steps: FlowStepJson[] = [
    {
      id: `${prefix}_greet`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: GREETING_BASE + bookingLink
    },
    {
      id: `${prefix}_notify`,
      type: "notify_owner",
      message:
        `New ${offerLabel} lead: {{vars.lead_name}} — {{vars.lead_phone}} / {{vars.lead_email}}. ` +
        "Details: {{vars.lead_notes}}. I sent them your greeting and I'm on follow-up duty."
    }
  ];

  for (let i = 1; i <= 3; i++) {
    const replyVar = `reply_${i}`;
    steps.push({
      id: `${prefix}_wait_${i}`,
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: replyVar,
      timeoutMinutes: i === 1 ? 120 : 1440,
      ...(i > 1 ? { when: { var: `reply_${i - 1}`, equals: "no_reply" } } : {})
    });
    steps.push({
      id: `${prefix}_nudge_${i}`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: nudgeBody(i, bookingLink),
      quietHours: { ...KYP_QUIET_HOURS },
      when: { var: replyVar, equals: "no_reply" }
    });
  }

  steps.push(
    {
      id: `${prefix}_wait_final`,
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: "reply_final",
      timeoutMinutes: 1440,
      when: { var: "reply_3", equals: "no_reply" }
    },
    {
      id: `${prefix}_flag_owner`,
      type: "notify_owner",
      message:
        "Personal touch needed: {{vars.lead_name}} ({{vars.lead_phone}}) hasn't replied to 3 follow-ups. " +
        "I've marked them Inactive — they're never deleted, and if they reply later the conversation picks right back up.",
      when: { var: "reply_final", equals: "no_reply" }
    },
    {
      id: `${prefix}_mark_inactive`,
      type: "update_contact",
      phoneVar: "lead_phone",
      addTags: ["Inactive"],
      when: { var: "reply_final", equals: "no_reply" }
    }
  );

  return steps;
}

/** KYP's live routed lead-follow-up definition (see patch-kyp-offer-branch.ts). */
export function buildKypOfferDefinition(): Record<string, unknown> {
  return {
    version: 1,
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
          },
          {
            name: "lead_industry",
            description:
              'The lead\'s industry from the lead form; if not provided, a short natural fallback like "your industry"'
          },
          {
            name: "lead_form_name",
            description:
              "The Facebook lead form name (form_name field from the webhook payload); 'unknown' if missing."
          }
        ]
      },
      {
        id: "s_file",
        type: "upsert_customer",
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        emailVar: "lead_email"
      },
      {
        id: "s_branch_offer",
        type: "branch",
        question: "Route by offer",
        branches: [
          {
            id: "arm_simple_form",
            label: "$100/week (Simple form)",
            condition: {
              var: "lead_form_name",
              contains: "Simple form setup 5/7/26",
              caseInsensitive: true
            },
            steps: offerArmSteps("s100", KYP_LINK_100, "$100/week")
          },
          {
            id: "arm_100_week",
            label: "$100/week (form says 100/week)",
            condition: {
              var: "lead_form_name",
              contains: "100/week",
              caseInsensitive: true
            },
            steps: offerArmSteps("s100b", KYP_LINK_100, "$100/week")
          }
        ],
        else: offerArmSteps("s200", KYP_LINK_200, "$200/week")
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
