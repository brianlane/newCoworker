/**
 * kyp-reminder-flow-definition.ts: the canonical KYP Ads calendar-side flow
 * definitions, "Pre-call reminder (1hr before) confirm attendance"
 * (`8e4e1c35`) and "Booking confirmation (SMS + email) live" (`b19af4e3`).
 *
 * Why this file exists at all: neither flow had a repo copy. They were built
 * during the white-glove install and edited live afterwards, so the only
 * copy was the `ai_flows` row. That is how the defect below survived a
 * platform fix aimed at the very same failure mode: there was nothing in the
 * repo to grep, review, or test.
 *
 * Captured from live on 2026-08-05, shape for shape, including the bug. Live
 * is the source of truth on this tenant (see kyp-lead-flow-definition.ts for
 * the Jul 19-24 unledgered reshape that established the rule), so the
 * reconcile direction is live -> builder, never the reverse.
 *
 * THE DEFECT, kept here deliberately so a test can prove it:
 * `invitee_tz_plain` asks the extractor for a timezone from a five-item
 * NORTH AMERICAN list and instructs it to return 'Eastern' when unclear. On
 * 2026-08-05 a lead in `Europe/London` (Reem, +19134399078) was therefore
 * told her 13:00Z call was "2:00 PM Eastern time (your local time)". It was
 * 2:00 PM UK. She was later told there was no call starting while it was
 * seven minutes away, and she canceled.
 *
 * The trigger payload was never wrong. It carried both
 * `invitee timezone: Europe/London` and
 * `starts (invitee local time): Wednesday, August 5, 2026 at 2:00 PM`.
 * Only the extraction contract was wrong.
 *
 * Same defect class as KYP/Ayanna on 2026-07-20, whose fix (PRs #810/#814/
 * #824) added `timeZoneName: "short"` to `calendar-tools` and
 * `contact-booking-context` but never reached this surface.
 *
 * Any change to these two flows belongs HERE, applied through a
 * ledger-recorded one-shot, so the builder and the tenant cannot drift.
 */

export const KYP_REMINDER_FLOW_ID = "8e4e1c35-911b-42a1-953d-33c4d7737159";
export const KYP_BOOKING_CONFIRMATION_FLOW_ID = "b19af4e3-17f9-49f8-ad16-608f90cf3ea3";

export const KYP_REMINDER_FLOW_NAME =
  "Pre-call reminder (1hr before) — confirm attendance";
export const KYP_BOOKING_CONFIRMATION_FLOW_NAME =
  "Booking confirmation (SMS + email) — live";

/** The connection the confirmation email sends from (live value). */
export const KYP_BOOKING_EMAIL_CONNECTION_ID = "a256f9c3-9b51-446f-b32c-d2c5fe11df3c";

type FlowFieldJson = { name: string; description: string };
type FlowStepJson = Record<string, unknown>;

/**
 * The invitee's own wall-clock start time.
 *
 * The platform already computes this and states it verbatim on the
 * `starts (invitee local time):` line
 * (src/lib/ai-flows/calendly-poll.ts, formatInviteeLocalTime). Asking the
 * model to "convert using their booking timezone" re-derives an answer the
 * payload already contains, which is avoidable risk for no gain.
 */
export const INVITEE_LOCAL_TIME_FIELD: FlowFieldJson = {
  name: "invitee_local_time",
  description:
    "The call start time in the INVITEE's own local timezone, formatted like '10:00 AM'. Convert using their booking timezone. Never return 'none'."
};

/**
 * The defect. A closed North American list plus a guessing fallback, applied
 * to a payload that already names the zone. Any invitee outside these five
 * zones is silently relabeled 'Eastern'.
 */
export const INVITEE_TZ_PLAIN_FIELD: FlowFieldJson = {
  name: "invitee_tz_plain",
  description:
    "Invitee's timezone in plain words: 'Eastern', 'Central', 'Mountain', 'Pacific', or 'Atlantic'. NEVER return 'none' or blank. If unclear, return 'Eastern'."
};

/** Live body of the 1-hour reminder text. */
export const KYP_REMINDER_SMS_BODY =
  "Hi {{vars.invitee_first_name}}, it's Samantha again, James's assistant at KYP Ads. Just a heads up that your call with James is coming up today at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}} time (your local time). \n\nCould you quickly confirm you're still good to hop on the Zoom? James has had a lot of demand lately so I want to make sure we hold your spot. Here's your link: {{vars.zoom_link}} \n\nJust reply and let me know, talk soon! \nSam";

/** Live body of the booking-confirmation text. */
export const KYP_BOOKING_CONFIRMATION_SMS_BODY =
  "Hi {{vars.invitee_name.first}}, this is Samantha, James's assistant at KYP Ads. You're all set for your free strategy call on {{vars.invitee_day_date}} at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}} time (your local time). It's a relaxed Zoom, James will get to know your business and map out how he'd bring you more leads, and you can see if it's a fit. Here's your link for when it's time: {{vars.zoom_link}} If anything comes up just reply here and I'll take care of it. Talk soon, Sam";

/** Live body of the booking-confirmation email. */
export const KYP_BOOKING_CONFIRMATION_EMAIL_BODY =
  "Hi {{vars.invitee_name.first}},\n\nThis is Samantha, James's assistant at KYP Ads. Just wanted to reach out personally and let you know you're all set for your free strategy call on {{vars.invitee_day_date}} at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}} time (your local time).\n\nIt's a relaxed Zoom call. James will get to know your business, walk through how he'd bring you more leads, and you can get a feel for whether it's the right fit. No pressure at all.\n\nHere's your link to join when it's time: {{vars.zoom_link}}\n\nIf anything comes up or you need to move the time, just reply here or text the number that messaged you and I'll take care of it.\n\nLooking forward to having you on,\n\nSam\nKYP Ads\nkypads.com\n+14388035806";

/** Live owner-notify line for a new booking. */
export const KYP_BOOKING_CONFIRMATION_NOTIFY =
  "New booking: {{vars.invitee_name}} for {{vars.invitee_day_date}} at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}}. Email: {{vars.invitee_email}}. Phone: {{vars.invitee_phone}}.";

/**
 * "Pre-call reminder (1hr before) confirm attendance", flow `8e4e1c35`.
 *
 * Fires on `event_start` for any event titled "KYP Ads | Free Strategy Call",
 * which covers both the $100 event type (slug `my-free-scale-plan`) and the
 * $200 one (slug `kyp-ads-free-strategy-2`, titled
 * "KYP Ads | Free Strategy Call | Client").
 */
export function buildKypPreCallReminderDefinition(): Record<string, unknown> {
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
          description: "The invitee's phone number, digits and + only. 'none' when absent."
        },
        INVITEE_LOCAL_TIME_FIELD,
        INVITEE_TZ_PLAIN_FIELD,
        {
          name: "zoom_link",
          description:
            "The Zoom/video join link (full https URL) from the location line. 'none' when absent."
        },
        {
          name: "invitee_email",
          description: "The invitee's email address from the 'invitee email:' line. 'none' when absent."
        }
      ]
    },
    {
      id: "file_invitee",
      type: "upsert_customer",
      when: { var: "invitee_phone", notEquals: "none" },
      nameVar: "invitee_first_name",
      emailVar: "invitee_email",
      phoneVar: "invitee_phone"
    },
    {
      id: "reminder_sms",
      to: "{{vars.invitee_phone}}",
      body: KYP_REMINDER_SMS_BODY,
      type: "send_sms"
    }
  ];

  return {
    steps,
    options: {
      allowReentry: true,
      agentInvocable: false,
      stopOnResponse: false,
      suppressDefaultReply: false,
      captureStepScreenshots: false
    },
    trigger: {
      on: "event_start",
      channel: "calendar",
      calendar: "primary",
      conditions: [
        { type: "contains", value: "KYP Ads | Free Strategy Call", caseInsensitive: true }
      ],
      leadMinutes: 60
    },
    version: 1
  };
}

/**
 * "Booking confirmation (SMS + email) live", flow `b19af4e3`.
 *
 * `lead_reachable` is the renamed `has_phone` gate
 * (rename-phone-named-gate-fields.ts): a phone-token field name would be
 * rewritten to "none" by the phone validator and kill both gated steps.
 */
export function buildKypBookingConfirmationDefinition(): Record<string, unknown> {
  const steps: FlowStepJson[] = [
    {
      id: "extract_invitee",
      type: "extract_text",
      fields: [
        { name: "invitee_name", description: "The invitee's full name from the booking." },
        {
          name: "invitee_phone",
          description:
            "The invitee's phone in E.164 (digits and leading +). Return 'none' if absent or if it matches the business's own number."
        },
        { name: "invitee_email", description: "The invitee's email address. 'none' when absent." },
        INVITEE_LOCAL_TIME_FIELD,
        INVITEE_TZ_PLAIN_FIELD,
        {
          name: "invitee_day_date",
          description:
            "The day and date of the call in the invitee's local time, e.g. 'Monday, July 28'. 'none' when absent."
        },
        {
          name: "zoom_link",
          description: "The Zoom/video join link (full https URL). 'none' when absent."
        },
        {
          name: "lead_reachable",
          description:
            "Exactly 'yes' if invitee_phone is a real usable number; 'no' if it is 'none' or missing."
        }
      ]
    },
    {
      id: "confirm_email",
      to: "{{vars.invitee_email}}",
      body: KYP_BOOKING_CONFIRMATION_EMAIL_BODY,
      type: "send_email",
      subject: "You're booked in, your KYP Ads strategy call on {{vars.invitee_day_date}}",
      fromConnectionId: KYP_BOOKING_EMAIL_CONNECTION_ID
    },
    {
      id: "confirm_sms",
      to: "{{vars.invitee_phone}}",
      body: KYP_BOOKING_CONFIRMATION_SMS_BODY,
      type: "send_sms",
      when: { var: "lead_reachable", equals: "yes" }
    },
    {
      id: "file_contact",
      type: "update_contact",
      when: { var: "lead_reachable", equals: "yes" },
      addTags: ["Booked call"],
      phoneVar: "invitee_phone"
    },
    {
      id: "notify_james",
      type: "notify_owner",
      message: KYP_BOOKING_CONFIRMATION_NOTIFY
    }
  ];

  return {
    steps,
    trigger: {
      channel: "webhook",
      conditions: [{ type: "contains", value: "calendly_booking", caseInsensitive: true }]
    },
    version: 1
  };
}
