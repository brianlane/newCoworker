import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE
} from "../../supabase/functions/_shared/sms_prompt_lines";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../../supabase/functions/_shared/reply_reasoning";
import {
  formatFlowAnswerNote,
  formatFlowRunContext
} from "../../supabase/functions/_shared/ai_flows/run_context";
import { buildCustomerPreambleForEdge } from "../../supabase/functions/_shared/customer_memory_preamble";
import { currentDateTimeLine } from "../../supabase/functions/_shared/datetime_line";
import { geminiChatReply, geminiJson } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { stepOf } from "./flow-walker";
import { walkFlowTimed, type TimedWalkResult } from "./flow-run-replay";

/**
 * The Alex replay (Truly Insurance, 2026-07-14, run 5820f7f0): the full
 * "Lead intake & follow-up (Privyr) (copy)" flow — the tenant's EXACT
 * enabled production definition, verbatim below — executed end to end with
 * live Gemini decisions and the production timeline:
 *
 *   17:08  Privyr "New Lead: Alex 😁" email triggers the flow
 *   17:09  flow texts the intro; Alex replies "I am looking for auto
 *          insurance" 18 seconds later (wait_intro consumes it)
 *   17:10  classify → gave_info → else arm texts "Approximately when does
 *          your current policy renew?" and IMMEDIATELY parks on the
 *          route_to_team agent offer (10-minute window)
 *   17:10  Alex answers "July 23, 2026" 16 seconds after the question —
 *          the run is parked awaiting_agent, NO wait is listening
 *          (wait_renewal sits AFTER route_to_team), so the deadline answer
 *          falls through to the generic AI reply path, which answered
 *          "I'm sorry, I need a bit more context…". The renewal date was
 *          never captured for the broker.
 *
 * Two contracts, both violated in production and pinned here:
 *
 *  1. FLOW OWNERSHIP: the intake flow must own the renewal answer — a
 *     policy DEADLINE — in vars for the broker handoff, and no lead text
 *     may fall through to the generic path mid-intake.
 *  2. FALLBACK CONTEXT: even when a lead text does land on the generic
 *     path, the assistant (with the exact production preamble) must read a
 *     bare date as the answer to the renewal question it can see was just
 *     asked — never ask the lead what the date means.
 */

const LEAD = "+15199560528";
const RENEWAL_ANSWER = "July 23, 2026";

/** What the tenant's SMS Coworker agent runs (deploy-client.sh
 * SMS_CHAT_MODEL default; upgraded off 2.5-flash-lite after this incident —
 * the old model ignored the system preamble on the incident turn). */
const TRULY_SMS_CHAT_MODEL = "gemini-3.1-flash-lite";

/** The real Privyr alert email that triggered the run (trigger.windowText
 * verbatim, tracking URLs and all — extraction must survive the noise). */
const PRIVYR_EMAIL = [
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

const TRIGGER = {
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
const TRULY_PRIVYR_FLOW = {
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
function flowSteps(): FlowStep[] {
  return parseAiFlowDefinition(TRULY_PRIVYR_FLOW).steps as unknown as FlowStep[];
}

/**
 * Alex's production timeline in minutes since the run's first step:
 * the intro answer landed ~18s after the ack, the renewal answer ~16s
 * after the question — i.e. both within a minute or two, while the run
 * had already parked on the 10-minute route_to_team offer.
 */
const ALEX_INBOUND = [
  { text: "I am looking for auto insurance", atMinutes: 0.3 },
  { text: RENEWAL_ANSWER, atMinutes: 1.4 }
];

let walk: TimedWalkResult;

beforeAll(async () => {
  walk = await walkFlowTimed(flowSteps(), {
    trigger: TRIGGER,
    inbound: ALEX_INBOUND,
    ai: { json: geminiJson }
  });
}, 120_000);

describe("Truly Privyr flow replay — Alex 2026-07-14 (full flow, live decisions)", () => {
  it("replays production's intake decisions (fidelity check)", () => {
    // Live extraction pulled Alex out of the noisy Privyr alert.
    expect(String(walk.vars.lead_name)).toMatch(/alex/i);
    expect(String(walk.vars.lead_phone)).toContain("5199560528");
    expect(String(walk.vars.product)).toMatch(/auto/i);
    // Live classify read "I am looking for auto insurance" as gave_info,
    // so the else arm asked the renewal question — same as production.
    expect(walk.vars.intent).toBe("gave_info");
    expect(
      walk.sends.some((s) => s.body.includes("when does your current policy renew"))
    ).toBe(true);
    expect(stepOf(walk, "offer_team").status).toBe("done");
  });

  it("the flow OWNS the renewal deadline: wait_renewal captures Alex's answer", () => {
    // Production violation: the run was parked awaiting_agent when the
    // answer arrived, wait_renewal never saw it, and renewal_timing timed
    // out to "no_reply" — the broker never got the July 23 deadline.
    expect(walk.vars.renewal_timing).toBe(RENEWAL_ANSWER);
  });

  it("acknowledges the captured deadline to the lead (renewal_ack fires)", () => {
    expect(stepOf(walk, "renewal_ack").status).toBe("done");
    expect(walk.sends.some((s) => s.body.startsWith("Perfect, thank you Alex"))).toBe(true);
  });

  it("the broker offer carries the renewal answer", () => {
    const offer = String(stepOf(walk, "offer_team").result.offer ?? "");
    expect(offer).toContain('Renewal: "{{vars.renewal_timing}}"');
  });

  it("no lead text falls through to the generic AI path mid-intake", () => {
    // Each entry here is a customer message the flow asked for but never
    // received — in production it landed on a context-poor generic reply
    // ("I'm sorry, I need a bit more context…").
    expect(walk.fellThroughToGenericPath).toEqual([]);
  });
});

describe("generic-path fallback turn — the incident turn's exact prompt", () => {
  // The EXACT production preamble of the incident turn (verified against
  // the stored Rowboat conversation 6a566d80a138dbaf59c8db5f), rebuilt from
  // the same production builders the SMS worker uses, with the flow state
  // taken from the walk above. With the fixed flow this exact message no
  // longer falls through — but ANY lead text arriving during a
  // route_to_team park still does, so the fallback path must read a bare
  // answer in context. Mirrors the worker's post-incident shape: the
  // fresh-thread flow-answer note rides inside the user turn
  // (formatFlowAnswerNote → sms_rowboat userTurnNote).
  let reply = "";
  let reasoningPresent = false;
  let verdict: JudgeVerdict;

  beforeAll(async () => {
    const dateLine = currentDateTimeLine(
      new Date("2026-07-14T17:10:24.259Z"),
      "America/New_York"
    );
    const phoneLine =
      `Current texter phone: ${LEAD}. When calling customer tools ` +
      `(customer_lookup_by_phone, customer_set_display_name, ` +
      `customer_append_pinned_note), pass this exact value as the phone ` +
      `argument unless the texter explicitly refers to a different number.`;
    const memoryPreamble = buildCustomerPreambleForEdge({
      customer_e164: LEAD,
      display_name: "Alex",
      summary_md: null,
      pinned_md: null,
      total_interaction_count: 4,
      last_channel: "sms",
      last_interaction_at: "2026-07-14T17:10:05.883783+00:00"
    });
    // The conversation state AT THE INCIDENT MOMENT: the flow has texted the
    // intro and the renewal question (nothing after), and the run is parked.
    // Rendered by the walk so the bodies are the real templated sends —
    // the same bodies loadFlowRunContext quotes from the outbound log.
    const allFlowSends = walk.sends.filter((s) => s.to === LEAD).map((s) => s.body);
    const renewalQuestionIdx = allFlowSends.findIndex((b) =>
      b.includes("when does your current policy renew")
    );
    const flowMessages = allFlowSends.slice(0, renewalQuestionIdx + 1);
    const flowContext = formatFlowRunContext(
      [
        {
          flowName: "Lead intake & follow-up (Privyr) (copy)",
          status: "awaiting_agent",
          updatedAt: "2026-07-14T17:10:06.54938+00:00",
          vars: {
            intent: String(walk.vars.intent ?? "gave_info"),
            product: String(walk.vars.product ?? "Auto"),
            lead_name: "Alex",
            lead_phone: LEAD,
            reply_text: "I am looking for auto insurance",
            claimed_agent: "none"
          }
        }
      ],
      flowMessages
    )!;
    const system =
      [
        `${SMS_IDENTITY_LINE}\n\n${SMS_GROUNDED_ACTIONS_LINE}\n\n${SMS_CONVERSATION_QUALITY_LINE}\n\n${dateLine}\n\n${phoneLine}`,
        memoryPreamble,
        flowContext
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") + REASONING_PROMPT_INSTRUCTION;

    // The worker's fresh-thread anchor: the last automated message rides
    // inside the user turn (see sms-inbound-worker's flowAnswerNote +
    // sms_rowboat's userTurnNote), because the incident model ignored the
    // same fact when it lived only in the system preamble.
    const note = formatFlowAnswerNote(flowMessages[flowMessages.length - 1] ?? "");
    const userTurn = note ? `${note}\n\n[SMS] ${RENEWAL_ANSWER}` : `[SMS] ${RENEWAL_ANSWER}`;
    const raw = await geminiChatReply(
      system,
      [{ role: "user", text: userTurn }],
      TRULY_SMS_CHAT_MODEL
    );
    const split = splitReplyReasoning(raw);
    reply = split.reply;
    reasoningPresent = split.reasoning !== null;
    verdict = await judgeReply(
      "an automated intake just asked the insurance lead 'approximately when does " +
        "your current policy renew?', and the lead answered with only a date",
      reply,
      {
        asks_what_date_means:
          "Does the message ask the customer to clarify, provide more context, or " +
          "explain what the date refers to or what they need — i.e. does it fail to " +
          "recognize the date as an answer to a question? A reply that acknowledges " +
          "the date as their policy renewal timing and moves forward is false.",
        treats_as_renewal:
          "Does the message treat the date as the customer's answer about when their " +
          "insurance policy renews — acknowledging, confirming, or noting it as their " +
          "renewal timing (in any phrasing)?",
        restarts_conversation:
          "Does the message greet or introduce the sender as if the conversation were " +
          "just starting (a fresh 'thanks for reaching out' opener, introducing " +
          "themselves by name), rather than continuing mid-thread?"
      }
    );
  }, 120_000);

  it("answers substantively", () => {
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it("reads the bare date as the renewal answer it can see was just asked", () => {
    // Production violation: "I'm sorry, I need a bit more context to
    // understand what you're referring to…" — the deadline was in plain
    // sight in the automation-context block.
    expect(verdict.answers.asks_what_date_means).toBe(false);
    expect(verdict.answers.treats_as_renewal).toBe(true);
  });

  it("does not restart the conversation", () => {
    expect(verdict.answers.restarts_conversation).toBe(false);
  });

  it("emits the reasoning trailer (production's incident turn skipped it)", () => {
    expect(reasoningPresent).toBe(true);
  });
});
