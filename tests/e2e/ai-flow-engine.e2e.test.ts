import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types";
import { NO_REPLY_SENTINEL } from "../../supabase/functions/_shared/ai_flows/steps";
import { geminiJson } from "./gemini";
import { stepOf, walkFlow } from "./flow-walker";

/**
 * End-to-end AiFlow execution with the REAL model making the decisions.
 *
 * The fixture is the Truly Insurance lead-intake flow (condensed, WITH the
 * post-incident fix: a wait_for_reply after the renewal question). The
 * scenarios replay the actual production conversation of 2026-07-11 —
 * Dwight's real messages — plus the other classify arms, and assert the
 * flow takes the right path, sends the right texts, and keeps ownership of
 * the lead's answers instead of dead-ending.
 *
 * Every branch decision here is a LIVE Gemini classify/extract call using
 * the worker's exact prompts, parsers, and generation config — this is the
 * layer unit tests cannot cover (they script the model's answers).
 */

const PRIVYR_EMAIL = [
  "New lead: Dwight Colclough",
  "You have a new lead from your campaign.",
  "",
  "Name: Dwight Colclough",
  "Phone: +14168775223",
  "Email: dwight.colclough@amresupply.com",
  "Interested in: Auto insurance quote",
  "",
  "Sent via Privyr"
].join("\n");

/** Dwight's actual first reply from the production thread. */
const DWIGHT_REPLY_1 =
  "I'm tired of insurance refusing to I've me insurance because of this no fault " +
  "accident crappie now because now I have to take a bus to work which cost to much " +
  "money.Now my truck has been parked since April 17th and I still have to make " +
  "payments on it. DWIGHT";

/** His answer to the renewal question — the message the dead-end dropped. */
const DWIGHT_REPLY_2 = "Was supposed to of been Apil 17th but they would not Renew it";

/** The classify contract shared by the first-reply and late-reply forks. */
const CLASSIFY_CATEGORIES = [
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
] as const;

/**
 * Truly-shaped lead intake, condensed to the paths under test and including
 * the wait_renewal fix shipped after the incident AND the late-reply patch
 * (scripts/oneshot/patch-truly-late-reply-and-source.ts, applied 2026-07-10):
 * the reply_fork else-arm forks on the nudge's late reply and mirrors the
 * first-reply arm — classify + route — instead of capturing it and ENDING
 * (the "Dawnia" dead end). That arm has never fired in production; this is
 * its only execution coverage.
 */
const LEAD_INTAKE_FLOW = {
  version: 1,
  trigger: {
    channel: "tenant_email",
    conditions: [
      { type: "from_matches", value: "lead-forwarding@privyr.com" },
      { type: "contains", value: "new lead", caseInsensitive: true }
    ]
  },
  options: { suppressDefaultReply: false },
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
      id: "ack",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body:
        "Hi {{vars.lead_name}}! Thanks for requesting a quote from Truly Insurance. " +
        "What prompted you to shop around today?"
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
                "A new insurance lead was just asked what prompted them to shop around today. " +
                "This is their reply.",
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
                      type: "send_sms",
                      to: "{{vars.lead_phone}}",
                      body:
                        "Absolutely - I'll get you connected with one of our licensed brokers right away."
                    },
                    {
                      id: "offer_team_call",
                      type: "route_to_team",
                      responseMinutes: 10,
                      offerTemplate: "Hot lead - WANTS A CALL: {{vars.lead_name}} ({{vars.lead_phone}}).",
                      ownerFallbackTemplate: "No broker claimed {{vars.lead_name}}. Back to you."
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
                      type: "send_sms",
                      to: "{{vars.lead_phone}}",
                      body: "No problem at all, {{vars.lead_name}} - thanks for letting us know."
                    },
                    {
                      id: "tag_lost",
                      type: "update_contact",
                      phoneVar: "lead_phone",
                      addTags: ["Lost"]
                    }
                  ]
                }
              ],
              else: [
                {
                  id: "continue_convo",
                  type: "send_sms",
                  to: "{{vars.lead_phone}}",
                  body:
                    "Thanks for sharing that - I've made a note for your broker. " +
                    "Approximately when does your current policy renew?"
                },
                {
                  id: "offer_team",
                  type: "route_to_team",
                  responseMinutes: 10,
                  offerTemplate: "New lead: {{vars.lead_name}} ({{vars.lead_phone}}).",
                  ownerFallbackTemplate: "No broker claimed {{vars.lead_name}}. Back to you."
                },
                {
                  // The post-incident fix under test: the flow must OWN the
                  // renewal answer instead of ending one second after asking.
                  id: "wait_renewal",
                  type: "wait_for_reply",
                  saveAs: "renewal_timing",
                  phoneVar: "lead_phone",
                  timeoutMinutes: 240
                },
                {
                  id: "renewal_ack",
                  type: "send_sms",
                  to: "{{vars.lead_phone}}",
                  when: { var: "renewal_timing", notEquals: "no_reply" },
                  body:
                    "Perfect, thank you {{vars.lead_name}} - I've noted that for your broker."
                }
              ]
            }
          ]
        }
      ],
      // The patched late-reply arm (production shape from the oneshot):
      // nudge → wait → fork on the late reply.
      else: [
        {
          id: "nudge1",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body: "Hi {{vars.lead_name}}! Just checking in to see if you're still interested."
        },
        {
          id: "wait2",
          type: "wait_for_reply",
          phoneVar: "lead_phone",
          saveAs: "reply2",
          timeoutMinutes: 2880
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
                  phoneVar: "lead_phone",
                  addTags: ["Engaged"],
                  removeTags: ["Contacted"]
                },
                {
                  id: "classify_late",
                  type: "classify",
                  saveAs: "late_intent",
                  textVar: "reply2",
                  question:
                    "An insurance lead was nudged about reviewing their options. This is their reply.",
                  categories: [...CLASSIFY_CATEGORIES]
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
                          type: "send_sms",
                          to: "{{vars.lead_phone}}",
                          body:
                            "Absolutely - I'll get you connected with one of our licensed brokers right away."
                        },
                        {
                          id: "late_offer_call",
                          type: "route_to_team",
                          responseMinutes: 10,
                          offerTemplate:
                            'Hot Truly lead (Privyr) - WANTS A CALL: {{vars.lead_name}} ({{vars.lead_phone}}). Their reply: "{{vars.reply2}}".',
                          ownerFallbackTemplate:
                            "No broker claimed {{vars.lead_name}} - they asked for a call. Back to you."
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
                          type: "send_sms",
                          to: "{{vars.lead_phone}}",
                          body:
                            "No problem at all, {{vars.lead_name}} - thanks for letting us know."
                        },
                        {
                          id: "late_tag_lost",
                          type: "update_contact",
                          phoneVar: "lead_phone",
                          addTags: ["Lost"],
                          removeTags: ["New Lead", "Contacted", "Engaged"]
                        },
                        {
                          id: "late_lost_note",
                          type: "notify_owner",
                          message:
                            '{{vars.lead_name}} ({{vars.lead_phone}}) said they\'re not interested. Their reply: "{{vars.reply2}}"'
                        }
                      ]
                    }
                  ],
                  else: [
                    {
                      id: "late_continue",
                      type: "send_sms",
                      to: "{{vars.lead_phone}}",
                      body:
                        "Thanks for getting back to us - I've made a note for your broker."
                    },
                    {
                      id: "late_offer_team",
                      type: "route_to_team",
                      responseMinutes: 10,
                      offerTemplate:
                        'New Truly lead (Privyr): {{vars.lead_name}} ({{vars.lead_phone}}). They replied to the check-in: "{{vars.reply2}}".',
                      ownerFallbackTemplate:
                        "No broker claimed {{vars.lead_name}} (Privyr). Back to you."
                    }
                  ]
                }
              ]
            }
          ],
          // reply2 == "no_reply" is guaranteed here (production comment): the
          // second nudge, then a final wait that closes out a silent lead.
          else: [
            {
              id: "nudge2",
              type: "send_sms",
              to: "{{vars.lead_phone}}",
              body:
                "Hi {{vars.lead_name}}, one of our licensed brokers would be happy to review your options whenever it suits you."
            },
            {
              id: "wait3",
              type: "wait_for_reply",
              phoneVar: "lead_phone",
              saveAs: "reply3",
              timeoutMinutes: 4320
            },
            {
              id: "late_engaged_2",
              type: "update_contact",
              when: { var: "reply3", notEquals: "no_reply" },
              phoneVar: "lead_phone",
              addTags: ["Engaged"],
              removeTags: ["Contacted"]
            },
            {
              id: "final_touch",
              type: "send_sms",
              when: { var: "reply3", equals: "no_reply" },
              to: "{{vars.lead_phone}}",
              body:
                "Hi {{vars.lead_name}}, we'll leave you be for now — if you'd ever like a no-pressure review, just reply here."
            },
            {
              id: "tag_inactive",
              type: "update_contact",
              when: { var: "reply3", equals: "no_reply" },
              phoneVar: "lead_phone",
              addTags: ["Inactive"],
              removeTags: ["New Lead", "Contacted", "Engaged"]
            }
          ]
        }
      ]
    }
  ]
};

const TRIGGER = {
  channel: "tenant_email",
  from: "lead-forwarding@privyr.com",
  windowText: PRIVYR_EMAIL
};

/** Schema-validated steps (a broken fixture must fail here, not mid-walk). */
function flowSteps(): FlowStep[] {
  return parseAiFlowDefinition(LEAD_INTAKE_FLOW).steps as unknown as FlowStep[];
}

describe("AiFlow engine e2e (live Gemini decisions)", () => {
  it(
    "replays the Truly incident: gave_info routes to the else arm and the flow keeps the renewal answer",
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(flowSteps(), {
        trigger: TRIGGER,
        replies: [DWIGHT_REPLY_1, DWIGHT_REPLY_2],
        ai: { json: geminiJson }
      });

      // Live extraction pulled the lead identity out of the Privyr email.
      expect(String(result.vars.lead_name)).toMatch(/dwight/i);
      expect(String(result.vars.lead_phone)).toContain("4168775223");
      expect(String(result.vars.lead_email).toLowerCase()).toBe(
        "dwight.colclough@amresupply.com"
      );
      expect(String(result.vars.product)).toMatch(/auto/i);

      // Live classify read Dwight's rant as information, not a call request.
      expect(result.vars.intent).toBe("gave_info");
      expect(stepOf(result, "call_ack").status).toBe("skipped");
      expect(stepOf(result, "polite_close").status).toBe("skipped");

      // The else arm asked the renewal question…
      const askBodies = result.sends.map((s) => s.body);
      expect(askBodies.some((b) => b.includes("when does your current policy renew"))).toBe(true);
      // …and (the incident fix) the flow consumed the answer and acknowledged
      // it, instead of finishing and dropping the reply on the generic AI.
      expect(result.vars.renewal_timing).toBe(DWIGHT_REPLY_2);
      expect(stepOf(result, "renewal_ack").status).toBe("done");
      expect(askBodies.some((b) => b.startsWith("Perfect, thank you Dwight"))).toBe(true);
    }
  );

  it(
    "a call request takes the wants_a_call arm and routes the team",
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(flowSteps(), {
        trigger: TRIGGER,
        replies: ["Yes please have someone call me right away today"],
        ai: { json: geminiJson }
      });
      expect(result.vars.intent).toBe("wants_a_call");
      expect(stepOf(result, "call_ack").status).toBe("done");
      expect(stepOf(result, "offer_team_call").status).toBe("done");
      expect(stepOf(result, "continue_convo").status).toBe("skipped");
      expect(stepOf(result, "renewal_ack").status).toBe("skipped");
    }
  );

  it(
    "an opt-out takes the not_interested arm: polite close + Lost tag, no follow-up question",
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(flowSteps(), {
        trigger: TRIGGER,
        replies: ["Please stop texting me, I'm all set with my current provider"],
        ai: { json: geminiJson }
      });
      expect(result.vars.intent).toBe("not_interested");
      expect(stepOf(result, "polite_close").status).toBe("done");
      expect(stepOf(result, "tag_lost").status).toBe("done");
      expect(result.sends.some((s) => s.body.includes("policy renew"))).toBe(false);
    }
  );

  it(
    "a fully silent lead closes out: nudges, final touch, Inactive tag — and no classify call",
    { retry: 1, timeout: 120_000 },
    async () => {
      let modelCalls = 0;
      const countingAi = {
        json: (prompt: string) => {
          modelCalls += 1;
          return geminiJson(prompt);
        }
      };
      const result = await walkFlow(flowSteps(), {
        trigger: TRIGGER,
        replies: [null, null, null],
        ai: countingAi
      });
      expect(result.vars.reply_text).toBe(NO_REPLY_SENTINEL);
      expect(stepOf(result, "nudge1").status).toBe("done");
      expect(stepOf(result, "classify_reply").status).toBe("skipped");
      // The late_fork else-arm: second nudge, final wait times out, and the
      // lead is closed out politely instead of dangling forever.
      expect(result.vars.reply2).toBe(NO_REPLY_SENTINEL);
      expect(result.vars.reply3).toBe(NO_REPLY_SENTINEL);
      expect(stepOf(result, "nudge2").status).toBe("done");
      expect(stepOf(result, "classify_late").status).toBe("skipped");
      expect(stepOf(result, "late_engaged_2").status).toBe("skipped");
      expect(stepOf(result, "final_touch").status).toBe("done");
      expect(stepOf(result, "tag_inactive").status).toBe("done");
      // Only the extraction hit the model; timed-out waits must never burn
      // classify calls.
      expect(modelCalls).toBe(1);
    }
  );

  // ── The late-reply patch (the "Dawnia" dead-end fix) ────────────────────
  // Before the oneshot, a reply that arrived AFTER the first nudge was
  // captured, tagged, and dropped: no classify, no routing, and the wait
  // suppressed the default assistant — "I would like to book a call" got
  // pure silence. These walks prove the patched arm routes every late-reply
  // intent exactly like a first reply.

  it(
    'a LATE "please call me" classifies wants_a_call and routes the team (the Dawnia case)',
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(flowSteps(), {
        trigger: TRIGGER,
        // Silent through the intro, then the nudge lands a call request.
        replies: [null, "I would like to book a call please, mornings work best"],
        ai: { json: geminiJson }
      });
      expect(result.vars.reply_text).toBe(NO_REPLY_SENTINEL);
      expect(stepOf(result, "nudge1").status).toBe("done");
      // Live classify on the LATE reply — the step the dead end never ran.
      expect(result.vars.late_intent).toBe("wants_a_call");
      expect(stepOf(result, "late_engaged_1").status).toBe("done");
      expect(stepOf(result, "late_call_ack").status).toBe("done");
      expect(stepOf(result, "late_offer_call").status).toBe("done");
      // The close-out arms stayed untaken.
      expect(stepOf(result, "late_polite_close").status).toBe("skipped");
      expect(stepOf(result, "nudge2").status).toBe("skipped");
      expect(stepOf(result, "tag_inactive").status).toBe("skipped");
    }
  );

  it(
    "a LATE opt-out closes politely: Lost tag + owner note, no more outreach",
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(flowSteps(), {
        trigger: TRIGGER,
        replies: [null, "No thanks, I'm all set with my current provider — please stop texting"],
        ai: { json: geminiJson }
      });
      expect(result.vars.late_intent).toBe("not_interested");
      expect(stepOf(result, "late_polite_close").status).toBe("done");
      expect(stepOf(result, "late_tag_lost").status).toBe("done");
      expect(stepOf(result, "late_lost_note").status).toBe("done");
      expect(stepOf(result, "late_call_ack").status).toBe("skipped");
      expect(stepOf(result, "late_continue").status).toBe("skipped");
      // The polite close is the LAST text this lead receives.
      const last = result.sends[result.sends.length - 1];
      expect(last.body).toContain("No problem at all");
    }
  );

  it(
    "a LATE info reply falls to the else arm: acknowledged and routed to the team",
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(flowSteps(), {
        trigger: TRIGGER,
        replies: [null, "My policy renews in September, paying about $210 a month right now"],
        ai: { json: geminiJson }
      });
      expect(result.vars.late_intent).toBe("gave_info");
      expect(stepOf(result, "late_continue").status).toBe("done");
      expect(stepOf(result, "late_offer_team").status).toBe("done");
      expect(stepOf(result, "late_call_ack").status).toBe("skipped");
      expect(stepOf(result, "late_polite_close").status).toBe("skipped");
    }
  );
});
