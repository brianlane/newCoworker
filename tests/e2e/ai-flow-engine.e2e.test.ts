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

/**
 * Truly-shaped lead intake, condensed to the paths under test and including
 * the wait_renewal fix shipped after the incident.
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
      else: [
        {
          id: "nudge1",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body: "Hi {{vars.lead_name}}! Just checking in to see if you're still interested."
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
    "a silent lead times out into the nudge arm (no classify call is made)",
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
        replies: [null],
        ai: countingAi
      });
      expect(result.vars.reply_text).toBe(NO_REPLY_SENTINEL);
      expect(stepOf(result, "nudge1").status).toBe("done");
      expect(stepOf(result, "classify_reply").status).toBe("skipped");
      // Only the extraction hit the model; a timed-out wait must never burn
      // a classify call.
      expect(modelCalls).toBe(1);
    }
  );
});
