/**
 * kyp-lead-flow-definition.ts, the canonical KYP Ads "Lead follow-up
 * (white-glove build)" flow definition (previously kyp-offer-definition.ts).
 *
 * History: the flow shipped flat (apply-kyp-intake.ts, Jul 15 2026), gained
 * an in-flow $100/$200 offer branch (patch-kyp-offer-branch.ts, PR #715,
 * last applied Jul 19), and was then reshaped OUTSIDE the one-shot ledger
 * sometime between Jul 19 and Jul 24: flat again, offer selection moved to a
 * trigger condition (webhook payload contains the Simple-form name), new
 * James-voiced copy, and the nudge quiet-hours window widened to 21:00
 * (strip-em-dashes-flows swept its copy Jul 24, the row's last write).
 * Decision, Aug 1 2026: the LIVE flow is the source of truth. This builder
 * now encodes that live shape plus the bad-phone intake arm
 * (patch-kyp-bad-phone-intake.ts), and the stale branch-shape applier
 * patch-kyp-offer-branch.ts is retired (scripts/oneshot/README.md,
 * "Removed").
 *
 * Any change to KYP's lead-flow shape belongs HERE, applied through a
 * ledger-recorded one-shot, so the builder and the tenant never drift again.
 * tests/oneshot-kyp-definitions.test.ts pins the invariants that have bitten
 * in production (2 AM nudges Jul 19; the Aug 1 undialable-lead dead end) and
 * the equivalence between this builder and the bad-phone patch transform.
 */

export const KYP_FLOW_NAME = "Lead follow-up (white-glove build)";

/** The live booking link (every arm now books the same free call). */
export const KYP_BOOKING_LINK = "calendly.com/james-kyp-ads/my-free-scale-plan";

/**
 * The nudge gate as it runs live: still America/Toronto with an 11:00
 * morning resume (the Jul 19 2026 2 AM incident pin), but the evening edge
 * sits at 21:00 since the unledgered Jul 19-24 reshape. Live is truth, so
 * 21:00 is canonical; the greeting stays ungated (60-second first touch).
 */
export const KYP_QUIET_HOURS = {
  timezone: "America/Toronto",
  noSendAfter: "21:00",
  resumeAt: "11:00"
} as const;

/**
 * Flow-level business-hours window for KYP's OTHER flows (booking
 * confirmation, no-show, wrong-link, proposal), applied by
 * patch-kyp-business-hours.ts. Unchanged: 11:00-18:00.
 */
export const KYP_TIME_WINDOW = {
  timezone: "America/Toronto",
  start: "11:00",
  end: "18:00"
} as const;

export const BAD_PHONE_NOTIFY_ID = "s_bad_phone_notify";
export const BAD_PHONE_EMAIL_ID = "s_bad_phone_email";
export const WHEN_BAD_PHONE = { var: "lead_phone", equals: "none" } as const;
export const WHEN_HAS_PHONE = { var: "lead_phone", notEquals: "none" } as const;

type FlowStepJson = Record<string, unknown>;

/**
 * The bad-phone intake arm (Aug 1 2026: a lead typed +16133439985030 and the
 * run died at the greeting): tell James, email the lead the booking link.
 * Shared with patch-kyp-bad-phone-intake.ts so the applied transform and
 * this canonical builder can never disagree on the copy.
 */
export function kypBadPhoneSteps(): FlowStepJson[] {
  return [
    {
      id: BAD_PHONE_NOTIFY_ID,
      type: "notify_owner",
      when: { ...WHEN_BAD_PHONE },
      message:
        "Heads up: new lead {{vars.lead_name}} ({{vars.lead_email}}) came in with a phone " +
        "number that can't be texted. I emailed them your booking link and asked for a " +
        "working number. Details: {{vars.lead_notes}}."
    },
    {
      id: BAD_PHONE_EMAIL_ID,
      type: "send_email",
      when: { ...WHEN_BAD_PHONE },
      to: "{{vars.lead_email}}",
      subject: "Your free strategy call with KYP Ads",
      body:
        "Hi {{vars.lead_name.first}}, it's James from KYP Ads. Thanks for your interest! " +
        "We tried to text you, but the phone number that came through with your form " +
        "doesn't look right, so I wanted to make sure you don't miss out.\n\n" +
        `You can grab a time for your free call here: ${KYP_BOOKING_LINK}\n\n` +
        "Or just reply to this email with your best number and I'll text you.\n\n" +
        "James"
    }
  ];
}

/** KYP's canonical lead-follow-up definition: the live shape + bad-phone arm. */
export function buildKypLeadFollowUpDefinition(): Record<string, unknown> {
  return {
    version: 1,
    trigger: {
      channel: "webhook",
      conditions: [
        { type: "contains", value: "Simple form setup 5/7/26", caseInsensitive: true }
      ]
    },
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
              "The lead's specific industry from the form. If it is missing, blank, 'Other', or 'N/A', return exactly 'your business'. Only return a real specific industry when clearly given (e.g. real estate, dentistry, landscaping)."
          },
          {
            name: "lead_form_name",
            description:
              "The Facebook lead form name (form_name field from the webhook payload); 'unknown' if missing."
          }
        ]
      },
      ...kypBadPhoneSteps(),
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
        body:
          "Hey {{vars.lead_name.first}}, it's James from KYP Ads. Saw you're looking to grow " +
          "{{vars.lead_industry}} and get more leads coming in. We run Facebook and Instagram ads " +
          "that bring local businesses a steady flow of real customers, not just clicks. Happy to " +
          "map out exactly how we'd do it for you on a quick free call. Grab a time here: " +
          KYP_BOOKING_LINK
      },
      {
        id: "s_notify",
        type: "notify_owner",
        when: { ...WHEN_HAS_PHONE },
        message:
          "New lead: {{vars.lead_name}}, {{vars.lead_phone}} / {{vars.lead_email}}. Industry: " +
          "{{vars.lead_industry}}. Details: {{vars.lead_notes}}. I sent them the greeting and " +
          "I'm on follow-up duty."
      },
      {
        id: "s_wait_1",
        type: "wait_for_reply",
        when: { ...WHEN_HAS_PHONE },
        saveAs: "reply_1",
        phoneVar: "lead_phone",
        timeoutMinutes: 120
      },
      {
        id: "s_nudge_1",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        when: { var: "reply_1", equals: "no_reply" },
        quietHours: { ...KYP_QUIET_HOURS },
        body:
          "Hey {{vars.lead_name.first}}, still keen to help you get more leads coming in. The " +
          "call's free and takes about 15 minutes, I'll show you what's working for businesses " +
          `like yours right now. Any time here work? ${KYP_BOOKING_LINK}`
      },
      {
        id: "s_wait_2",
        type: "wait_for_reply",
        when: { var: "reply_1", equals: "no_reply" },
        saveAs: "reply_2",
        phoneVar: "lead_phone",
        timeoutMinutes: 1440
      },
      {
        id: "s_nudge_2",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        when: { var: "reply_2", equals: "no_reply" },
        quietHours: { ...KYP_QUIET_HOURS },
        body:
          "Morning {{vars.lead_name.first}}. Quick thought, most businesses we talk to are " +
          "leaving leads on the table because their ads aren't set up to actually convert. " +
          "That's the fixable part. Want to grab 15 minutes and I'll walk you through it? " +
          KYP_BOOKING_LINK
      },
      {
        id: "s_wait_3",
        type: "wait_for_reply",
        when: { var: "reply_2", equals: "no_reply" },
        saveAs: "reply_3",
        phoneVar: "lead_phone",
        timeoutMinutes: 1440
      },
      {
        id: "s_nudge_3",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        when: { var: "reply_3", equals: "no_reply" },
        quietHours: { ...KYP_QUIET_HOURS },
        body:
          "Hey {{vars.lead_name.first}}, I'll leave this with you. If you're still looking to " +
          "bring in more customers, my calendar's here whenever the timing's right: " +
          `${KYP_BOOKING_LINK} Either way, best of luck with the business.`
      },
      {
        id: "s_wait_final",
        type: "wait_for_reply",
        when: { var: "reply_3", equals: "no_reply" },
        saveAs: "reply_final",
        phoneVar: "lead_phone",
        timeoutMinutes: 1440
      },
      {
        id: "s_flag_owner",
        type: "notify_owner",
        when: { var: "reply_final", equals: "no_reply" },
        message:
          "Personal touch needed: {{vars.lead_name}} ({{vars.lead_phone}}) hasn't replied to 3 " +
          "follow-ups. I've marked them Inactive, they're never deleted, and if they reply later " +
          "the conversation picks right back up."
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
