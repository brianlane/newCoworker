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
 * THE INCIDENT THAT SHAPED THIS FILE (Reem, +19134399078, 2026-08-05):
 * `invitee_tz_plain` asked the extractor for a timezone from a five-item
 * NORTH AMERICAN list and told it to return 'Eastern' when unclear. A lead in
 * `Europe/London` was therefore told her 13:00Z call was "2:00 PM Eastern
 * time (your local time)". It was 2:00 PM UK. She was later told there was no
 * call starting while it was seven minutes away, and she canceled.
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
 * THE RULE THIS FILE NOW KEEPS: never state a timezone the flow had to guess.
 * Customer copy quotes `invitee_local_time`, which IS the invitee's own wall
 * clock, and says "your time" without naming a zone. The owner notify, which
 * goes to James and not to a customer, carries the zone verbatim from the
 * payload so he can tell whose 2:00 PM it is.
 *
 * A SECOND RULE SINCE AUG 27 2026 (fleet fallback-composition audit): never
 * quote a detail the extraction may have missed inside a spoken sentence.
 * Several fields fall back to the literal word 'none', so the old
 * single-template copy could read "your call on none at none your time" to a
 * customer the moment a Calendly payload arrived without its usual lines
 * (0 misses observed so far, but the send steps had no guard at all). Each
 * customer send now comes as a guarded pair: the specific copy runs only when
 * a details-known gate extracted 'yes', and a generic sibling that points at
 * the calendar invite runs otherwise. The owner notify instead labels each
 * fact ("Day: none" reads as a fact where "for none" read as gibberish).
 *
 * Any change to these two flows belongs HERE, applied through a
 * ledger-recorded one-shot, so the builder and the tenant cannot drift.
 */

/**
 * Flows are resolved by NAME plus the business id passed on argv, per the
 * scripts/oneshot convention, so no row id is load-bearing here and none can
 * go stale.
 */
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
    "The clock time from the 'starts (invitee local time):' line, copied verbatim, like '10:00 AM'. It is ALREADY in the invitee's own timezone: never convert or shift it, and never infer it from another line. Never return 'none'."
};

/**
 * The invitee's zone, copied rather than named.
 *
 * This replaced `invitee_tz_plain`, which offered a closed North American
 * list and a 'Eastern' fallback, so a Europe/London invitee had no correct
 * answer available. An IANA identifier is stated verbatim on the payload's
 * `invitee timezone:` line, so it can be copied and cannot be invented.
 *
 * It is used ONLY in the owner notify. Customer copy names no zone at all.
 */
export const INVITEE_TIMEZONE_IANA_FIELD: FlowFieldJson = {
  name: "invitee_timezone_iana",
  description:
    "The invitee's timezone exactly as written on the 'invitee timezone:' line, e.g. 'America/Toronto' or 'Europe/London'. Copy it verbatim. Never translate it into a zone name or abbreviation, and never substitute another zone. Return 'none' if that line is absent."
};

/**
 * Details-known gates. A guard can test a var against a value but not test
 * two vars at once, so each flow extracts ONE yes/no fact covering every
 * detail its specific copy quotes. The fields the gates summarize fall back
 * to 'none' individually; the gate is what keeps 'none' out of a sentence.
 */
export const BOOKING_DETAILS_KNOWN_FIELD: FlowFieldJson = {
  name: "booking_details_known",
  description:
    "Exactly 'yes' when the message states all three of: the day/date of the call, the 'starts (invitee local time):' clock time, and a Zoom/video join link. Otherwise exactly 'no'."
};

export const REMINDER_DETAILS_KNOWN_FIELD: FlowFieldJson = {
  name: "reminder_details_known",
  description:
    "Exactly 'yes' when the message states both the 'starts (invitee local time):' clock time and a Zoom/video join link. Otherwise exactly 'no'."
};

/**
 * Body of the 1-hour reminder text.
 *
 * "your time" rather than a named zone: `invitee_local_time` is already the
 * invitee's own wall clock, so the sentence is true for every invitee on
 * earth and there is nothing left to guess wrong.
 */
export const KYP_REMINDER_SMS_BODY =
  "Hi {{vars.invitee_first_name}}, it's Samantha again, James's assistant at KYP Ads. Just a heads up that your call with James is coming up today at {{vars.invitee_local_time}} your time. \n\nCould you quickly confirm you're still good to hop on the Zoom? James has had a lot of demand lately so I want to make sure we hold your spot. Here's your link: {{vars.zoom_link}} \n\nJust reply and let me know, talk soon! \nSam";

/**
 * The reminder when the payload did not carry the time or the link. "within
 * the hour" is always true for this flow (it fires on `leadMinutes: 60`), and
 * the calendar invite the invitee already holds has both details.
 */
export const KYP_REMINDER_SMS_BODY_MISSING =
  "Hi {{vars.invitee_first_name}}, it's Samantha again, James's assistant at KYP Ads. Just a heads up that your call with James is coming up within the hour. \n\nCould you quickly confirm you're still good to hop on the Zoom? James has had a lot of demand lately so I want to make sure we hold your spot. The link is in your calendar invite. \n\nJust reply and let me know, talk soon! \nSam";

/** Body of the booking-confirmation text. */
export const KYP_BOOKING_CONFIRMATION_SMS_BODY =
  "Hi {{vars.invitee_name.first}}, this is Samantha, James's assistant at KYP Ads. You're all set for your free strategy call on {{vars.invitee_day_date}} at {{vars.invitee_local_time}} your time. It's a relaxed Zoom, James will get to know your business and map out how he'd bring you more leads, and you can see if it's a fit. Here's your link for when it's time: {{vars.zoom_link}} If anything comes up just reply here and I'll take care of it. Talk soon, Sam";

/** The confirmation text when the payload was missing a detail the specific copy quotes. */
export const KYP_BOOKING_CONFIRMATION_SMS_BODY_MISSING =
  "Hi {{vars.invitee_name.first}}, this is Samantha, James's assistant at KYP Ads. You're all set for your free strategy call, the day, time, and Zoom link are in your calendar invite. It's a relaxed Zoom, James will get to know your business and map out how he'd bring you more leads, and you can see if it's a fit. If anything comes up just reply here and I'll take care of it. Talk soon, Sam";

/** Body of the booking-confirmation email. */
export const KYP_BOOKING_CONFIRMATION_EMAIL_BODY =
  "Hi {{vars.invitee_name.first}},\n\nThis is Samantha, James's assistant at KYP Ads. Just wanted to reach out personally and let you know you're all set for your free strategy call on {{vars.invitee_day_date}} at {{vars.invitee_local_time}} your time.\n\nIt's a relaxed Zoom call. James will get to know your business, walk through how he'd bring you more leads, and you can get a feel for whether it's the right fit. No pressure at all.\n\nHere's your link to join when it's time: {{vars.zoom_link}}\n\nIf anything comes up or you need to move the time, just reply here or text the number that messaged you and I'll take care of it.\n\nLooking forward to having you on,\n\nSam\nKYP Ads\nkypads.com\n+14388035806";

/**
 * The confirmation email when the payload was missing a detail. Drops the
 * day/time clause AND the join-link line (a missing link renders the literal
 * 'none' as a link target); everything else stays byte-identical to the
 * specific copy.
 */
export const KYP_BOOKING_CONFIRMATION_EMAIL_BODY_MISSING =
  "Hi {{vars.invitee_name.first}},\n\nThis is Samantha, James's assistant at KYP Ads. Just wanted to reach out personally and let you know you're all set for your free strategy call. The exact day, time, and Zoom link are in your calendar invite.\n\nIt's a relaxed Zoom call. James will get to know your business, walk through how he'd bring you more leads, and you can get a feel for whether it's the right fit. No pressure at all.\n\nIf anything comes up or you need to move the time, just reply here or text the number that messaged you and I'll take care of it.\n\nLooking forward to having you on,\n\nSam\nKYP Ads\nkypads.com\n+14388035806";

/** Specific subject quotes the day; the missing-details subject quotes nothing. */
export const KYP_BOOKING_CONFIRMATION_SUBJECT =
  "You're booked in, your KYP Ads strategy call on {{vars.invitee_day_date}}";
export const KYP_BOOKING_CONFIRMATION_SUBJECT_MISSING =
  "You're booked in, your KYP Ads strategy call";

/**
 * Owner-notify line for a new booking.
 *
 * This one goes to James, so it MUST keep the zone: the time is the
 * invitee's wall clock, and "2:00 PM" with no zone is the ambiguity that
 * started this whole incident. The zone is the verbatim IANA identifier from
 * the payload, so it is copied rather than guessed.
 *
 * Labelled facts rather than a sentence: several of these fields fall back
 * to 'none', and "Day: none" reads as a fact where the old "for none at
 * none" read as gibberish (fleet fallback-composition audit, Aug 27 2026).
 */
export const KYP_BOOKING_CONFIRMATION_NOTIFY =
  "New booking: {{vars.invitee_name}}. Day: {{vars.invitee_day_date}}. Time: {{vars.invitee_local_time}} invitee local time ({{vars.invitee_timezone_iana}}). Email: {{vars.invitee_email}}. Phone: {{vars.invitee_phone}}.";

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
        {
          name: "zoom_link",
          description:
            "The Zoom/video join link (full https URL) from the location line. 'none' when absent."
        },
        {
          name: "invitee_email",
          description: "The invitee's email address from the 'invitee email:' line. 'none' when absent."
        },
        REMINDER_DETAILS_KNOWN_FIELD
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
    // equals / notEquals on the same var and value form an exhaustive
    // either/or, so exactly one reminder goes out; a run started before the
    // gate existed has no var, which reads as notEquals and takes the safe
    // generic copy.
    {
      id: "reminder_sms",
      to: "{{vars.invitee_phone}}",
      body: KYP_REMINDER_SMS_BODY,
      type: "send_sms",
      when: { var: REMINDER_DETAILS_KNOWN_FIELD.name, equals: "yes" }
    },
    {
      id: "reminder_sms_missing",
      to: "{{vars.invitee_phone}}",
      body: KYP_REMINDER_SMS_BODY_MISSING,
      type: "send_sms",
      when: { var: REMINDER_DETAILS_KNOWN_FIELD.name, notEquals: "yes" }
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
        INVITEE_TIMEZONE_IANA_FIELD,
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
        },
        BOOKING_DETAILS_KNOWN_FIELD
      ]
    },
    {
      id: "confirm_email",
      to: "{{vars.invitee_email}}",
      body: KYP_BOOKING_CONFIRMATION_EMAIL_BODY,
      type: "send_email",
      subject: KYP_BOOKING_CONFIRMATION_SUBJECT,
      fromConnectionId: KYP_BOOKING_EMAIL_CONNECTION_ID,
      when: { var: BOOKING_DETAILS_KNOWN_FIELD.name, equals: "yes" }
    },
    {
      id: "confirm_email_missing",
      to: "{{vars.invitee_email}}",
      body: KYP_BOOKING_CONFIRMATION_EMAIL_BODY_MISSING,
      type: "send_email",
      subject: KYP_BOOKING_CONFIRMATION_SUBJECT_MISSING,
      fromConnectionId: KYP_BOOKING_EMAIL_CONNECTION_ID,
      when: { var: BOOKING_DETAILS_KNOWN_FIELD.name, notEquals: "yes" }
    },
    // A step carries ONE `when`, and this send needs lead_reachable AND the
    // details gate; the branch supplies the second condition. `else` stays
    // empty: an unreachable phone sends nothing, as before.
    {
      id: "confirm_sms_gate",
      type: "branch",
      question: "Does the invitee have a real phone to text?",
      branches: [
        {
          id: "confirm_sms_reachable",
          label: "Has a real phone",
          condition: { var: "lead_reachable", equals: "yes" },
          steps: [
            {
              id: "confirm_sms",
              to: "{{vars.invitee_phone}}",
              body: KYP_BOOKING_CONFIRMATION_SMS_BODY,
              type: "send_sms",
              when: { var: BOOKING_DETAILS_KNOWN_FIELD.name, equals: "yes" }
            },
            {
              id: "confirm_sms_missing",
              to: "{{vars.invitee_phone}}",
              body: KYP_BOOKING_CONFIRMATION_SMS_BODY_MISSING,
              type: "send_sms",
              when: { var: BOOKING_DETAILS_KNOWN_FIELD.name, notEquals: "yes" }
            }
          ]
        }
      ],
      else: []
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
