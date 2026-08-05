/**
 * The two KYP Ads calendar flows EXACTLY as they ran live on 2026-08-05,
 * the day the Reem timezone failure happened. Captured from the ai_flows
 * rows and verified byte-for-byte before any patch was written.
 *
 * This is the INPUT that scripts/oneshot/patch-kyp-timezone-labels.ts has to
 * turn into kyp-reminder-flow-definition.ts. Pinning that transform against
 * the real pre-fix shape (rather than against a shape derived from the
 * builder) is what makes the equivalence test meaningful: it proves the
 * one-shot would actually produce the canonical definition when run on the
 * tenant, which a round-trip through the builder could never show.
 *
 * Do not edit. If live has drifted from this, reconcile the builder to live
 * first (live is the source of truth on this tenant) and recapture.
 */

export const KYP_PRE_CALL_REMINDER_PRE_FIX = {
  "steps": [
    {
      "id": "extract_invitee",
      "type": "extract_text",
      "fields": [
        {
          "name": "invitee_first_name",
          "description": "The invitee's FIRST name only, from the 'invitee name:' line."
        },
        {
          "name": "invitee_phone",
          "description": "The invitee's phone number, digits and + only. 'none' when absent."
        },
        {
          "name": "invitee_local_time",
          "description": "The call start time in the INVITEE's own local timezone, formatted like '10:00 AM'. Convert using their booking timezone. Never return 'none'."
        },
        {
          "name": "invitee_tz_plain",
          "description": "Invitee's timezone in plain words: 'Eastern', 'Central', 'Mountain', 'Pacific', or 'Atlantic'. NEVER return 'none' or blank. If unclear, return 'Eastern'."
        },
        {
          "name": "zoom_link",
          "description": "The Zoom/video join link (full https URL) from the location line. 'none' when absent."
        },
        {
          "name": "invitee_email",
          "description": "The invitee's email address from the 'invitee email:' line. 'none' when absent."
        }
      ]
    },
    {
      "id": "file_invitee",
      "type": "upsert_customer",
      "when": {
        "var": "invitee_phone",
        "notEquals": "none"
      },
      "nameVar": "invitee_first_name",
      "emailVar": "invitee_email",
      "phoneVar": "invitee_phone"
    },
    {
      "id": "reminder_sms",
      "to": "{{vars.invitee_phone}}",
      "body": "Hi {{vars.invitee_first_name}}, it's Samantha again, James's assistant at KYP Ads. Just a heads up that your call with James is coming up today at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}} time (your local time). \n\nCould you quickly confirm you're still good to hop on the Zoom? James has had a lot of demand lately so I want to make sure we hold your spot. Here's your link: {{vars.zoom_link}} \n\nJust reply and let me know, talk soon! \nSam",
      "type": "send_sms"
    }
  ],
  "options": {
    "allowReentry": true,
    "agentInvocable": false,
    "stopOnResponse": false,
    "suppressDefaultReply": false,
    "captureStepScreenshots": false
  },
  "trigger": {
    "on": "event_start",
    "channel": "calendar",
    "calendar": "primary",
    "conditions": [
      {
        "type": "contains",
        "value": "KYP Ads | Free Strategy Call",
        "caseInsensitive": true
      }
    ],
    "leadMinutes": 60
  },
  "version": 1
} as const;

export const KYP_BOOKING_CONFIRMATION_PRE_FIX = {
  "steps": [
    {
      "id": "extract_invitee",
      "type": "extract_text",
      "fields": [
        {
          "name": "invitee_name",
          "description": "The invitee's full name from the booking."
        },
        {
          "name": "invitee_phone",
          "description": "The invitee's phone in E.164 (digits and leading +). Return 'none' if absent or if it matches the business's own number."
        },
        {
          "name": "invitee_email",
          "description": "The invitee's email address. 'none' when absent."
        },
        {
          "name": "invitee_local_time",
          "description": "The call start time in the INVITEE's own local timezone, formatted like '10:00 AM'. Convert using their booking timezone. Never return 'none'."
        },
        {
          "name": "invitee_tz_plain",
          "description": "Invitee's timezone in plain words: 'Eastern', 'Central', 'Mountain', 'Pacific', or 'Atlantic'. NEVER return 'none' or blank. If unclear, return 'Eastern'."
        },
        {
          "name": "invitee_day_date",
          "description": "The day and date of the call in the invitee's local time, e.g. 'Monday, July 28'. 'none' when absent."
        },
        {
          "name": "zoom_link",
          "description": "The Zoom/video join link (full https URL). 'none' when absent."
        },
        {
          "name": "lead_reachable",
          "description": "Exactly 'yes' if invitee_phone is a real usable number; 'no' if it is 'none' or missing."
        }
      ]
    },
    {
      "id": "confirm_email",
      "to": "{{vars.invitee_email}}",
      "body": "Hi {{vars.invitee_name.first}},\n\nThis is Samantha, James's assistant at KYP Ads. Just wanted to reach out personally and let you know you're all set for your free strategy call on {{vars.invitee_day_date}} at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}} time (your local time).\n\nIt's a relaxed Zoom call. James will get to know your business, walk through how he'd bring you more leads, and you can get a feel for whether it's the right fit. No pressure at all.\n\nHere's your link to join when it's time: {{vars.zoom_link}}\n\nIf anything comes up or you need to move the time, just reply here or text the number that messaged you and I'll take care of it.\n\nLooking forward to having you on,\n\nSam\nKYP Ads\nkypads.com\n+14388035806",
      "type": "send_email",
      "subject": "You're booked in, your KYP Ads strategy call on {{vars.invitee_day_date}}",
      "fromConnectionId": "a256f9c3-9b51-446f-b32c-d2c5fe11df3c"
    },
    {
      "id": "confirm_sms",
      "to": "{{vars.invitee_phone}}",
      "body": "Hi {{vars.invitee_name.first}}, this is Samantha, James's assistant at KYP Ads. You're all set for your free strategy call on {{vars.invitee_day_date}} at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}} time (your local time). It's a relaxed Zoom, James will get to know your business and map out how he'd bring you more leads, and you can see if it's a fit. Here's your link for when it's time: {{vars.zoom_link}} If anything comes up just reply here and I'll take care of it. Talk soon, Sam",
      "type": "send_sms",
      "when": {
        "var": "lead_reachable",
        "equals": "yes"
      }
    },
    {
      "id": "file_contact",
      "type": "update_contact",
      "when": {
        "var": "lead_reachable",
        "equals": "yes"
      },
      "addTags": [
        "Booked call"
      ],
      "phoneVar": "invitee_phone"
    },
    {
      "id": "notify_james",
      "type": "notify_owner",
      "message": "New booking: {{vars.invitee_name}} for {{vars.invitee_day_date}} at {{vars.invitee_local_time}} {{vars.invitee_tz_plain}}. Email: {{vars.invitee_email}}. Phone: {{vars.invitee_phone}}."
    }
  ],
  "trigger": {
    "channel": "webhook",
    "conditions": [
      {
        "type": "contains",
        "value": "calendly_booking",
        "caseInsensitive": true
      }
    ]
  },
  "version": 1
} as const;
