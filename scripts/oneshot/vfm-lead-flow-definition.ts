/**
 * vfm-lead-flow-definition.ts: the canonical Vantage Flow Media lead flow
 * for the KYP Ads tenant (seeded by seed-vfm-lead-aiflow.ts).
 *
 * VFM is the owner's second lead-gen business, run INSIDE the KYP tenant:
 * same login, same number, same box, standard features only. Meta lead ads
 * fire the shared webhook; this flow claims the VFM form names and KYP's
 * "Lead follow-up (white-glove build)" keeps its own, so the two brands
 * never cross (same mechanism, different `contains` values).
 *
 * Shape (one conversational flow; the owner's two asks share the thread):
 *
 *   intake      extract -> bad-phone arm -> file + tag "VFM" -> hand the
 *               lead to the VFM assignee (route_to_team pin; the business
 *               runs lead_auto_assign, so the pin IS the assignment and the
 *               assignee gets an FYI, no claim handshake). Ownership is what
 *               routes the lead's later reply pages to the assignee instead
 *               of the owner (contact_owner_target ladder).
 *   book        5-minute pause, then the booking link, then a 3-nudge
 *               reminder ladder chained on no_reply, quiet-hours gated in
 *               US Eastern (the assignee and the leads are US-based; the
 *               business timezone stays the owner's).
 *   confirm     The tenant CANNOT see bookings on the assignee's own
 *               Calendly account (one Calendly connection per business, and
 *               it is the owner's), so the booked call's time comes from
 *               the lead's own words: a run_agent parser turns the replies
 *               into an ISO instant or "none". When a time is known, sleep
 *               to T-60 and send the confirmation (owner's framing: limited
 *               number of new accounts each month, is the spot still
 *               needed), then report the outcome to the assignee.
 *
 * Copy rule: the flow NEVER states VFM's management price (three price
 *   points are being tested and the flow cannot know which offer a lead
 *   saw). The $30/day ad-spend minimum is deliberately absent from the
 *   copy too: price talk belongs on the call.
 *
 * Failure honesty: a lead who books but never says so in the thread gets
 *   no confirmation, and reminders stop only on reply or ladder end. That
 *   is the accepted cost of zero booking integration.
 *
 * Assignee modes: with a roster member (assigneeName), teammate touches are
 *   SMS via route_to_team/toAgentName. Until the assignee's mobile exists,
 *   emailOnly mode swaps every teammate touch for send_email and drops the
 *   route_to_team step (a roster row cannot exist without a phone).
 *
 * Pinned by tests/oneshot-vfm-definitions.test.ts. Any change to the VFM
 * flow shape belongs HERE, applied through the ledger-recorded seeder, so
 * the builder and the tenant never drift (the KYP lead-flow lesson).
 */

import { VFM_BOOKING_LINK } from "./vfm-brand-content.ts";

export const VFM_FLOW_NAME = "VFM lead follow-up (Vantage Flow Media)";

/** The Meta lead-form names that mark a lead as VFM's (owner, Aug 2026). */
export const VFM_FORM_NAMES = [
  "VFM | 100 Week Form",
  "VFM | 200 Week Form",
  "VF Media | High Intent v2 | Full Qualify | 08.01.26"
] as const;

/**
 * Nudge gate: US Eastern, where the assignee and the ad audience live. The
 * greeting stays ungated (first touch within minutes wins the lead), and
 * the T-60 confirmation stays ungated too: deferring it past the call time
 * would be worse than sending it early in the morning.
 */
export const VFM_QUIET_HOURS = {
  timezone: "America/New_York",
  noSendAfter: "20:00",
  resumeAt: "09:00"
} as const;

export const VFM_PARSER_AGENT_NAME = "VFM booked-time parser";

/**
 * Saved instructions for the run_agent parser: lead replies in, one ISO
 * instant (or "none") out. The flow's input template supplies today's date
 * ({{now.today.*}}) so relative phrases resolve.
 */
export const VFM_PARSER_AGENT_INSTRUCTIONS =
  "The input is a set of SMS replies from a sales lead, separated by | " +
  "(the token no_reply means they did not answer that message), plus " +
  "today's date. Decide whether the lead states that they booked or " +
  "scheduled a call, and at what date and time. If a specific upcoming " +
  "date and time can be determined, reply with ONLY that instant in ISO " +
  "8601 format with the correct US Eastern UTC offset, for example " +
  "2026-08-12T14:00:00-04:00. Interpret stated times as US Eastern unless " +
  "the lead clearly says otherwise. If the lead has not stated a booked " +
  "call time, or the time is in the past or ambiguous, reply with exactly: " +
  "none. Reply with a single line and nothing else.";

export const WHEN_BAD_PHONE = { var: "lead_phone", equals: "none" } as const;
export const WHEN_HAS_PHONE = { var: "lead_phone", notEquals: "none" } as const;
export const WHEN_TIME_KNOWN = { var: "call_time", notEquals: "none" } as const;

export type VfmFlowOptions = {
  /** Roster display name of the VFM assignee (route_to_team pin + SMS notifies). */
  assigneeName?: string;
  /** The assignee's email; every teammate touch goes here in emailOnly mode. */
  assigneeEmail: string;
  /** No roster row yet (no phone): teammate touches become send_email. */
  emailOnly: boolean;
  /** business_agents id of the booked-time parser (seeded by the same script). */
  parserAgentId: string;
};

type FlowStepJson = Record<string, unknown>;

/**
 * A teammate touchpoint: SMS to the pinned roster member, or email in
 * emailOnly mode. `id` must be unique per step; `subject` is only used for
 * the email form.
 */
function assigneeNotifyStep(
  opts: VfmFlowOptions,
  id: string,
  subject: string,
  body: string,
  when?: Record<string, unknown>
): FlowStepJson {
  if (opts.emailOnly || !opts.assigneeName) {
    return {
      id,
      type: "send_email",
      to: opts.assigneeEmail,
      subject,
      body,
      ...(when ? { when } : {})
    };
  }
  return {
    id,
    type: "send_sms",
    toAgentName: opts.assigneeName,
    body,
    ...(when ? { when } : {})
  };
}

/** The canonical VFM lead-flow definition. */
export function buildVfmLeadFlowDefinition(opts: VfmFlowOptions): Record<string, unknown> {
  const [firstForm, ...restForms] = VFM_FORM_NAMES;
  const webhookTrigger = (formName: string) => ({
    channel: "webhook",
    conditions: [{ type: "contains", value: formName, caseInsensitive: true }]
  });

  const leadDetails =
    "{{vars.lead_name}}, {{vars.lead_phone}} / {{vars.lead_email}}. " +
    "Form: {{vars.lead_form_name}}. Details: {{vars.lead_notes}}.";

  const steps: FlowStepJson[] = [
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
          name: "lead_form_name",
          description:
            "The Facebook lead form name (form_name field from the webhook payload); 'unknown' if missing."
        }
      ]
    },
    // Bad-phone arm (the KYP Aug 1 2026 lesson: an undialable number must
    // not dead-end the lead): tell the assignee, email the lead the link.
    assigneeNotifyStep(
      opts,
      "s_bad_phone_alert",
      "VFM lead with an unusable phone number",
      "Heads up: new VFM lead {{vars.lead_name}} ({{vars.lead_email}}) came in with a " +
        "phone number that can't be texted. I emailed them the booking link and asked " +
        "for a working number. Details: {{vars.lead_notes}}.",
      { ...WHEN_BAD_PHONE }
    ),
    {
      id: "s_bad_phone_email",
      type: "send_email",
      when: { ...WHEN_BAD_PHONE },
      to: "{{vars.lead_email}}",
      subject: "Your free strategy call with Vantage Flow Media",
      body:
        "Hi {{vars.lead_name.first}}, thanks for your interest in Vantage Flow Media! " +
        "We tried to text you, but the phone number that came through with your form " +
        "doesn't look right, so I wanted to make sure you don't miss out.\n\n" +
        `You can grab a time for your free strategy call here: ${VFM_BOOKING_LINK}\n\n` +
        "Or just reply to this email with your best number and we'll text you.",
      // send_email needs a recipient either way; a lead with neither phone
      // nor email is beyond software.
    },
    {
      id: "s_file",
      type: "upsert_customer",
      nameVar: "lead_name",
      emailVar: "lead_email",
      phoneVar: "lead_phone"
    },
    {
      id: "s_tag",
      type: "update_contact",
      when: { ...WHEN_HAS_PHONE },
      addTags: ["VFM"],
      phoneVar: "lead_phone"
    }
  ];

  // Hand the lead to the assignee. With lead_auto_assign on, the pin is a
  // hard assignment plus FYI text; ownership stamps immediately, which is
  // what redirects this lead's reply pages to the assignee.
  if (!opts.emailOnly && opts.assigneeName) {
    steps.push({
      id: "s_route",
      type: "route_to_team",
      when: { ...WHEN_HAS_PHONE },
      agentName: opts.assigneeName,
      offerTemplate: `New VFM lead: ${leadDetails} I'm sending them the booking link and following up.`,
      ownerFallbackTemplate:
        `VFM lead could not be handed to the team (roster problem): ${leadDetails} ` +
        "Please assign them by hand on the dashboard."
    });
  } else {
    steps.push(
      assigneeNotifyStep(
        opts,
        "s_fyi",
        "New VFM lead",
        `New VFM lead: ${leadDetails} I'm sending them the booking link and following up.`,
        { ...WHEN_HAS_PHONE }
      )
    );
  }

  steps.push(
    // The owner's spec: not booked within 5 minutes, send the link.
    { id: "s_delay", type: "sleep", minutes: 5, when: { ...WHEN_HAS_PHONE } },
    {
      id: "s_greet",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      when: { ...WHEN_HAS_PHONE },
      body:
        "Hey {{vars.lead_name.first}}, thanks for reaching out to Vantage Flow Media! " +
        "We build paid ad campaigns that turn clicks into booked clients, month to " +
        "month, no long-term contracts. The next step is a quick free strategy call. " +
        `Grab a time that works for you here: ${VFM_BOOKING_LINK}`
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
      quietHours: { ...VFM_QUIET_HOURS },
      body:
        "Hey {{vars.lead_name.first}}, just floating this back up. The strategy call " +
        "is free and takes about 15 minutes, and you'll walk away with a concrete plan " +
        `either way. Any time here work? ${VFM_BOOKING_LINK}`
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
      quietHours: { ...VFM_QUIET_HOURS },
      body:
        "Morning {{vars.lead_name.first}}. We take on a limited number of new accounts " +
        "each month, so if you're still looking to grow, now's a good time to lock in " +
        `your call: ${VFM_BOOKING_LINK}`
    },
    {
      id: "s_wait_3",
      type: "wait_for_reply",
      when: { var: "reply_2", equals: "no_reply" },
      saveAs: "reply_3",
      phoneVar: "lead_phone",
      timeoutMinutes: 1440
    },
    assigneeNotifyStep(
      opts,
      "s_final_flag",
      "VFM lead went quiet",
      "Personal touch needed: VFM lead {{vars.lead_name}} ({{vars.lead_phone}}) hasn't " +
        "replied to 3 messages. I've marked them Inactive; if they reply later the " +
        "conversation picks right back up.",
      { var: "reply_3", equals: "no_reply" }
    ),
    {
      id: "s_mark_inactive",
      type: "update_contact",
      when: { var: "reply_3", equals: "no_reply" },
      addTags: ["Inactive"],
      phoneVar: "lead_phone"
    },
    // The confirm arm. The parser reads whatever replies exist (skipped
    // waits leave their vars unset, which render empty) and anchors
    // relative phrases on {{now.today.*}}.
    {
      id: "s_parse_time",
      type: "run_agent",
      when: { ...WHEN_HAS_PHONE },
      agentId: opts.parserAgentId,
      agentName: VFM_PARSER_AGENT_NAME,
      input:
        "Today is {{now.today.weekday}}, {{now.today.iso}} (US Eastern). " +
        "SMS replies from the lead, oldest first: " +
        "{{vars.reply_1}} | {{vars.reply_2}} | {{vars.reply_3}}",
      saveAs: "call_time"
    },
    {
      id: "s_ack",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      when: { ...WHEN_TIME_KNOWN },
      body: "Perfect, you're locked in. Looking forward to it, talk soon!"
    },
    // T-60: anchored to the lead's stated time. An unparseable render skips
    // the sleep (worker fail-open) and the confirmation goes out right
    // away, which still reads fine after a fresh booking.
    {
      id: "s_sleep_t60",
      type: "sleep",
      when: { ...WHEN_TIME_KNOWN },
      relativeToTemplate: "{{vars.call_time}}",
      offsetMinutes: -60
    },
    {
      id: "s_confirm",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      when: { ...WHEN_TIME_KNOWN },
      body:
        "Hi {{vars.lead_name.first}}, quick check ahead of your strategy call. We take " +
        "on a limited number of new accounts each month, so we want to make sure the " +
        "spot is still needed. Reply YES to confirm, or if something came up you can " +
        `grab a new time here: ${VFM_BOOKING_LINK}`
    },
    {
      id: "s_confirm_wait",
      type: "wait_for_reply",
      when: { ...WHEN_TIME_KNOWN },
      saveAs: "confirm_reply",
      phoneVar: "lead_phone",
      timeoutMinutes: 50
    },
    assigneeNotifyStep(
      opts,
      "s_outcome",
      "VFM pre-call check outcome",
      "Pre-call check for VFM lead {{vars.lead_name}} ({{vars.lead_phone}}), call at " +
        "{{vars.call_time}}: their reply was: {{vars.confirm_reply}}",
      { ...WHEN_TIME_KNOWN }
    )
  );

  return {
    version: 1,
    trigger: webhookTrigger(firstForm),
    triggers: restForms.map(webhookTrigger),
    steps
  };
}
