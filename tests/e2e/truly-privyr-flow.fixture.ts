/**
 * The VERBATIM production definition of Truly Insurance's enabled
 * "Lead intake & follow-up (Privyr) (copy)" flow (ai_flows row
 * 70be1676-cb42-4419-a414-bd3136e56be6), WITH the post-incident ordering
 * fix applied by scripts/oneshot/patch-truly-renewal-wait-order.ts, plus
 * the real Privyr trigger email from the 2026-07-14 Alex incident.
 *
 * Shared by every Truly-replay e2e suite (truly-renewal-context,
 * truly-branch-matrix) so there is exactly ONE fixture to keep in lockstep
 * with the tenant's live definition. If Truly's flow is edited, refresh
 * this fixture from prod and let the branch-matrix suite's step-coverage
 * meta-assertion tell you which new steps lack a covering walk.
 */
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types";

/** The real Privyr alert email that triggered the run (trigger.windowText
 * verbatim, tracking URLs and all — extraction must survive the noise). */
export const PRIVYR_EMAIL = [
  "New Lead: Alex 😁",
  "Congrats! You have new lead fromMuhammad Fahad: Alex. Open in Privyr to " +
    "immediately follow up with them. Congrats! You have a new lead from " +
    "Muhammad Fahad Alex Lead via Privyr Lead Forms - Auto Lead Name: Alex " +
    "Phone: +15199560528 Email: Comments: Form Name: Auto Lead Lead Form Url: " +
    "https://www.privyr.com/form/mAldxHK5 Source: Privyr Lead Forms - Auto Lead " +
    "View this lead in Privyr to easily contact, manage, and follow up with them. " +
    "VIEW LEAD IN PRIVYR (https://2xgl9tx2.r.us-east-1.awstrack.me/L0/https:%2F%2Fapp.privyr.com%2Fclient%2F189022218/1/0100019f61999914-65076fde-b1ef-4fcd-88d1-2f07eb2b3e12-000000/Oc8q6pi3RUJDsRvW-ooJlSbXoFk=473) " +
    "Guides & tips to maximize your leads: Sending Personalized Quick Responses " +
    "Managing Your Leads New Lead Alerts & Reminders Don't want new lead alerts " +
    "via email? You can edit your notification settings."
].join("\n");

export const TRIGGER = {
  channel: "tenant_email",
  from: "alerts-noreply@privyr.com",
  subject: "New Lead: Alex 😁",
  windowText: PRIVYR_EMAIL
};

/**
 * The tenant's enabled production definition (ai_flows row
 * 70be1676-cb42-4419-a414-bd3136e56be6), WITH the post-incident ordering
 * fix applied by scripts/oneshot/patch-truly-renewal-wait-order.ts: the
 * intent_fork else-arm runs continue_convo → tag_engaged → wait_renewal
 * (30m) → renewal_ack → offer_team, and the offer template carries the
 * captured renewal answer. The incident shape had wait_renewal AFTER
 * offer_team, so the run was parked awaiting_agent when Alex answered and
 * the wait never saw the message. Keep this fixture in lockstep with the
 * oneshot's output.
 */
export const TRULY_PRIVYR_FLOW = {
  steps: [
    {
      id: "extract",
      type: "extract_text",
      fields: [
        { name: "lead_name", description: "The lead's full name" },
        { name: "lead_phone", description: "The lead's phone number" },
        { name: "lead_email", description: "The lead's email address" },
        { name: "product", description: "What they want to insure (auto, home, business...)" }
      ]
    },
    {
      id: "save_contact",
      type: "upsert_customer",
      nameVar: "lead_name",
      emailVar: "lead_email",
      phoneVar: "lead_phone"
    },
    {
      id: "tag_new",
      type: "update_contact",
      addTags: ["New Lead", "Privyr"],
      phoneVar: "lead_phone"
    },
    {
      id: "ack",
      to: "{{vars.lead_phone}}",
      body:
        "Hi {{vars.lead_name}}! Thanks for requesting a quote from Truly Insurance. " +
        "I'm Emma and I will help get you connected with one of our licensed brokers. " +
        "What prompted you to shop around today?",
      type: "send_sms"
    },
    {
      id: "tag_contacted",
      type: "update_contact",
      addTags: ["Contacted"],
      phoneVar: "lead_phone",
      removeTags: ["New Lead"]
    },
    {
      id: "wait_intro",
      type: "wait_for_reply",
      saveAs: "reply_text",
      phoneVar: "lead_phone",
      timeoutMinutes: 120
    },
    {
      id: "reply_fork",
      type: "branch",
      question: "Did the lead respond to the intro?",
      branches: [
        {
          id: "arm_called",
          label: "Called in",
          condition: { var: "reply_text", equals: "customer_called" },
          steps: [
            {
              id: "called_note",
              type: "notify_owner",
              message:
                "{{vars.lead_name}} ({{vars.lead_phone}}) called the office instead of " +
                "texting back — their automated follow-ups are paused. Update their " +
                "status on the Contacts page after the call."
            }
          ]
        },
        {
          id: "arm_replied",
          label: "Replied",
          condition: { var: "reply_text", notEquals: "no_reply" },
          steps: [
            {
              id: "classify_reply",
              type: "classify",
              saveAs: "intent",
              textVar: "reply_text",
              question:
                "A new insurance lead was just asked what prompted them to shop around " +
                "today. This is their reply.",
              categories: [
                {
                  value: "wants_a_call",
                  description: "asks to talk to someone, book, schedule, or be called now"
                },
                {
                  value: "not_interested",
                  description: "declines, says they're all set, or asks to stop texting"
                },
                {
                  value: "gave_info",
                  description: "answered the question - a reason, renewal timing, or other details"
                }
              ]
            },
            {
              id: "intent_fork",
              type: "branch",
              question: "What does the lead want?",
              branches: [
                {
                  id: "arm_call_now",
                  label: "Wants a call",
                  condition: { var: "intent", equals: "wants_a_call" },
                  steps: [
                    {
                      id: "call_ack",
                      to: "{{vars.lead_phone}}",
                      body:
                        "Absolutely - I'll get you connected with one of our licensed " +
                        "brokers right away. You can also reply here anytime with a day " +
                        "and time that suits you best.",
                      type: "send_sms",
                      quietHours: {
                        resumeAt: "08:00",
                        timezone: "America/New_York",
                        noSendAfter: "21:00"
                      }
                    },
                    {
                      id: "tag_engaged_call",
                      type: "update_contact",
                      addTags: ["Engaged"],
                      phoneVar: "lead_phone",
                      removeTags: ["Contacted"]
                    },
                    {
                      id: "offer_team_call",
                      type: "route_to_team",
                      offerWindow: {
                        quietEnd: "08:30",
                        timezone: "America/New_York",
                        quietStart: "21:00",
                        graceMinutes: 15
                      },
                      offerTemplate:
                        "Hot Truly lead (Privyr) - WANTS A CALL: {{vars.lead_name}} " +
                        '({{vars.lead_phone}}) - {{vars.product}}. Their reply: "{{vars.reply_text}}". ' +
                        "Reply 1 to claim or 2 to pass by {{offer.deadline}}.",
                      responseMinutes: 10,
                      preferContactOwner: true,
                      claimedNotifyTemplate:
                        "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}) - call requested.",
                      ownerFallbackTemplate:
                        "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - " +
                        "they asked for a call. Back to you."
                    }
                  ]
                },
                {
                  id: "arm_not_interested",
                  label: "Not interested",
                  condition: { var: "intent", equals: "not_interested" },
                  steps: [
                    {
                      id: "polite_close",
                      to: "{{vars.lead_phone}}",
                      body:
                        "No problem at all, {{vars.lead_name}} - thanks for letting us " +
                        "know. If anything changes, we'd be happy to help. Have a great day!",
                      type: "send_sms",
                      quietHours: {
                        resumeAt: "08:00",
                        timezone: "America/New_York",
                        noSendAfter: "21:00"
                      }
                    },
                    {
                      id: "tag_lost",
                      type: "update_contact",
                      addTags: ["Lost"],
                      phoneVar: "lead_phone",
                      removeTags: ["New Lead", "Contacted", "Engaged"]
                    },
                    {
                      id: "lost_note",
                      type: "notify_owner",
                      message:
                        "{{vars.lead_name}} ({{vars.lead_phone}}) said they're not " +
                        'interested - closed out politely and tagged Lost. Their reply: "{{vars.reply_text}}"'
                    }
                  ]
                }
              ],
              else: [
                {
                  id: "continue_convo",
                  to: "{{vars.lead_phone}}",
                  body:
                    "Thanks for sharing that - I've made a note for your broker. " +
                    "Approximately when does your current policy renew?",
                  type: "send_sms",
                  quietHours: {
                    resumeAt: "08:00",
                    timezone: "America/New_York",
                    noSendAfter: "21:00"
                  }
                },
                {
                  id: "tag_engaged",
                  type: "update_contact",
                  addTags: ["Engaged"],
                  phoneVar: "lead_phone",
                  removeTags: ["Contacted"]
                },
                {
                  id: "wait_renewal",
                  type: "wait_for_reply",
                  saveAs: "renewal_timing",
                  phoneVar: "lead_phone",
                  timeoutMinutes: 30
                },
                {
                  id: "renewal_ack",
                  to: "{{vars.lead_phone}}",
                  body:
                    "Perfect, thank you {{vars.lead_name}} — I've noted that for your " +
                    "broker. One of our licensed brokers will reach out shortly to review " +
                    "your options. If a specific day or time works best for a call, just " +
                    "reply here and let me know.",
                  type: "send_sms",
                  when: { var: "renewal_timing", notEquals: "no_reply" },
                  quietHours: {
                    resumeAt: "08:00",
                    timezone: "America/New_York",
                    noSendAfter: "21:00"
                  }
                },
                {
                  id: "offer_team",
                  type: "route_to_team",
                  offerWindow: {
                    quietEnd: "08:30",
                    timezone: "America/New_York",
                    quietStart: "21:00",
                    graceMinutes: 15
                  },
                  offerTemplate:
                    "New Truly lead (Privyr): {{vars.lead_name}} ({{vars.lead_phone}}) - " +
                    '{{vars.product}}. They just replied: "{{vars.reply_text}}". ' +
                    'Renewal: "{{vars.renewal_timing}}". Reply 1 to ' +
                    "claim or 2 to pass by {{offer.deadline}}. The assistant is booking them a call.",
                  responseMinutes: 10,
                  preferContactOwner: true,
                  claimedNotifyTemplate:
                    "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}).",
                  ownerFallbackTemplate:
                    "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - " +
                    "{{vars.product}}. Back to you."
                }
              ]
            }
          ]
        }
      ],
      else: [
        {
          id: "nudge1",
          to: "{{vars.lead_phone}}",
          body:
            "Hi {{vars.lead_name}}! Just checking in to see if you're still interested " +
            "in reviewing your insurance options. Whenever you're ready, we can pick up " +
            "right where we left off.",
          type: "send_sms",
          quietHours: { resumeAt: "08:00", timezone: "America/New_York", noSendAfter: "21:00" }
        },
        {
          id: "wait2",
          type: "wait_for_reply",
          saveAs: "reply2",
          phoneVar: "lead_phone",
          timeoutMinutes: 1440
        },
        {
          id: "late_fork",
          type: "branch",
          question: "Did the lead reply to the check-in?",
          branches: [
            {
              id: "arm_late_replied",
              label: "Replied late",
              condition: { var: "reply2", notEquals: "no_reply" },
              steps: [
                {
                  id: "late_engaged_1",
                  type: "update_contact",
                  addTags: ["Engaged"],
                  phoneVar: "lead_phone",
                  removeTags: ["Contacted"]
                },
                {
                  id: "classify_late",
                  type: "classify",
                  saveAs: "late_intent",
                  textVar: "reply2",
                  question:
                    "An insurance lead was nudged about reviewing their options. This is their reply.",
                  categories: [
                    {
                      value: "wants_a_call",
                      description: "asks to talk to someone, book, schedule, or be called now"
                    },
                    {
                      value: "not_interested",
                      description: "declines, says they're all set, or asks to stop texting"
                    },
                    {
                      value: "gave_info",
                      description: "shared details - a reason, renewal timing, or other info"
                    }
                  ]
                },
                {
                  id: "late_intent_fork",
                  type: "branch",
                  question: "What does the lead want?",
                  branches: [
                    {
                      id: "arm_late_call",
                      label: "Wants a call",
                      condition: { var: "late_intent", equals: "wants_a_call" },
                      steps: [
                        {
                          id: "late_call_ack",
                          to: "{{vars.lead_phone}}",
                          body:
                            "Absolutely - I'll get you connected with one of our licensed " +
                            "brokers right away. You can also reply here anytime with a " +
                            "day and time that suits you best.",
                          type: "send_sms",
                          quietHours: {
                            resumeAt: "08:00",
                            timezone: "America/New_York",
                            noSendAfter: "21:00"
                          }
                        },
                        {
                          id: "late_offer_call",
                          type: "route_to_team",
                          offerWindow: {
                            quietEnd: "08:30",
                            timezone: "America/New_York",
                            quietStart: "21:00",
                            graceMinutes: 15
                          },
                          offerTemplate:
                            "Hot Truly lead (Privyr) - WANTS A CALL: {{vars.lead_name}} " +
                            '({{vars.lead_phone}}) - {{vars.product}}. Their reply: "{{vars.reply2}}". ' +
                            "Reply 1 to claim or 2 to pass by {{offer.deadline}}.",
                          responseMinutes: 10,
                          preferContactOwner: true,
                          claimedNotifyTemplate:
                            "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}) - call requested.",
                          ownerFallbackTemplate:
                            "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - " +
                            "they asked for a call. Back to you."
                        }
                      ]
                    },
                    {
                      id: "arm_late_not_interested",
                      label: "Not interested",
                      condition: { var: "late_intent", equals: "not_interested" },
                      steps: [
                        {
                          id: "late_polite_close",
                          to: "{{vars.lead_phone}}",
                          body:
                            "No problem at all, {{vars.lead_name}} - thanks for letting " +
                            "us know. If anything changes, we'd be happy to help. Have a great day!",
                          type: "send_sms",
                          quietHours: {
                            resumeAt: "08:00",
                            timezone: "America/New_York",
                            noSendAfter: "21:00"
                          }
                        },
                        {
                          id: "late_tag_lost",
                          type: "update_contact",
                          addTags: ["Lost"],
                          phoneVar: "lead_phone",
                          removeTags: ["New Lead", "Contacted", "Engaged"]
                        },
                        {
                          id: "late_lost_note",
                          type: "notify_owner",
                          message:
                            "{{vars.lead_name}} ({{vars.lead_phone}}) said they're not " +
                            'interested - closed out politely and tagged Lost. Their reply: "{{vars.reply2}}"'
                        }
                      ]
                    }
                  ],
                  else: [
                    {
                      id: "late_continue",
                      to: "{{vars.lead_phone}}",
                      body:
                        "Thanks for getting back to us - I've made a note for your broker, " +
                        "and one of our licensed brokers will follow up with you shortly.",
                      type: "send_sms",
                      quietHours: {
                        resumeAt: "08:00",
                        timezone: "America/New_York",
                        noSendAfter: "21:00"
                      }
                    },
                    {
                      id: "late_offer_team",
                      type: "route_to_team",
                      offerWindow: {
                        quietEnd: "08:30",
                        timezone: "America/New_York",
                        quietStart: "21:00",
                        graceMinutes: 15
                      },
                      offerTemplate:
                        "New Truly lead (Privyr): {{vars.lead_name}} ({{vars.lead_phone}}) - " +
                        '{{vars.product}}. They replied to the check-in: "{{vars.reply2}}". ' +
                        "Reply 1 to claim or 2 to pass by {{offer.deadline}}.",
                      responseMinutes: 10,
                      preferContactOwner: true,
                      claimedNotifyTemplate:
                        "{{agent.name}} claimed {{vars.lead_name}} ({{vars.lead_phone}}).",
                      ownerFallbackTemplate:
                        "No broker claimed {{vars.lead_name}} ({{vars.lead_phone}}) - " +
                        "{{vars.product}} (Privyr). Back to you."
                    }
                  ]
                }
              ]
            }
          ],
          else: [
            {
              id: "nudge2",
              to: "{{vars.lead_phone}}",
              body:
                "Hi {{vars.lead_name}}, one of our licensed brokers would be happy to " +
                "review your options whenever it suits you — no pressure at all. Would a " +
                "quick call this week work?",
              type: "send_sms",
              quietHours: {
                resumeAt: "08:00",
                timezone: "America/New_York",
                noSendAfter: "21:00"
              }
            },
            {
              id: "wait3",
              type: "wait_for_reply",
              saveAs: "reply3",
              phoneVar: "lead_phone",
              timeoutMinutes: 4320
            },
            {
              id: "late_engaged_2",
              type: "update_contact",
              when: { var: "reply3", notEquals: "no_reply" },
              addTags: ["Engaged"],
              phoneVar: "lead_phone",
              removeTags: ["Contacted"]
            },
            {
              id: "final_touch",
              to: "{{vars.lead_phone}}",
              body:
                "Hi {{vars.lead_name}}, we'll leave you be for now — if you'd ever like a " +
                "no-pressure review of your insurance options, just reply here and we'll " +
                "pick up right where we left off. Thanks for considering Truly Insurance!",
              type: "send_sms",
              when: { var: "reply3", equals: "no_reply" },
              quietHours: {
                resumeAt: "08:00",
                timezone: "America/New_York",
                noSendAfter: "21:00"
              }
            },
            {
              id: "tag_inactive",
              type: "update_contact",
              when: { var: "reply3", equals: "no_reply" },
              addTags: ["Inactive"],
              phoneVar: "lead_phone",
              removeTags: ["New Lead", "Contacted", "Engaged"]
            }
          ]
        }
      ]
    }
  ],
  options: { suppressDefaultReply: false, captureStepScreenshots: false },
  trigger: {
    channel: "tenant_email",
    conditions: [
      { type: "from_matches", value: "lead-forwarding@privyr.com" },
      { type: "contains", value: "new lead", caseInsensitive: true }
    ]
  },
  version: 1,
  triggers: [
    {
      channel: "tenant_email",
      conditions: [
        { type: "from_matches", value: "alerts-noreply@privyr.com" },
        { type: "contains", value: "new lead:", caseInsensitive: true }
      ]
    }
  ]
};

/** Schema-validated steps (a broken fixture must fail here, not mid-walk). */
export function trulyFlowSteps(): FlowStep[] {
  return parseAiFlowDefinition(TRULY_PRIVYR_FLOW).steps as unknown as FlowStep[];
}
