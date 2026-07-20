import { describe, expect, it } from "vitest";
import {
  INQUIRY_REGEX,
  LEAD_FLOW_NAME,
  REALTOR_INTEGRATION_LABEL,
  REPLY_FLOW_NAME,
  STAR_ROW,
  addRetriggerGuard,
  hardenOwnerDirectAlerts,
  replyForwardDefinition
} from "../scripts/oneshot/realtor-retrigger-guard";
import { parseAiFlowDefinition, type TriggerCondition } from "@/lib/ai-flows/schema";
import { evaluateTriggerConditions } from "@/lib/ai-flows/trigger-eval";

/**
 * Realtor.com retrigger guard one-shot (Jennifer Phillips, Jul 19 2026): a
 * lead's reply relayed by realtor.com re-matched the lead flow's lone
 * `contains rltr.pro` condition and re-routed a $1.75M owner-kept lead to
 * the team. The one-shot tightens the trigger to inquiry notifications,
 * opts the flow into the worker's lead-dedupe gate, seeds a reply-forward
 * flow, and frames every $1M+ owner-direct SMS in '*' rows.
 */

/** The two realtor.com relay shapes from the incident (verbatim structure). */
const INQUIRY_TEXT =
  "New inquiry: Jennifer Phillips 480-274-0963 jenphillips9819@gmail.com " +
  "( https://rltr.pro/B6bh5 ) 24027 S 121st Pl, Chandler, AZ 85249, USA $1,750,000/6BR/5BA";
const REPEAT_TEXT =
  "Repeat inquiry: Stacy Bastien (840) 275-3158 Stacybastien1968@gmail.com " +
  "( https://rltr.pro/NmyJQ ) 3131 W Cochise Dr Unit 257, Phoenix, AZ 85051, USA $100,000/1BR";
const REPLY_TEXT =
  'New text reply from Jennifer Phillips: "I have a few questions before we would like to to..." ' +
  "Click here to respond ( https://rltr.pro/XKVuC )";

/** Amy's live flow shape, reduced to what the one-shot touches. */
function leadFlowDef(): Record<string, unknown> {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      conditions: [{ type: "contains", value: "rltr.pro", caseInsensitive: true }],
      correlationWindowMinutes: 1
    },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "Buyer name" },
          { name: "lead_phone", description: "Buyer phone" },
          { name: "price_band", description: "over_1m or under_1m" }
        ]
      },
      {
        id: "s4",
        type: "route_to_team",
        offerTemplate: "New lead {{vars.lead_name}}",
        responseMinutes: 10,
        ownerFallbackTemplate: "No agent claimed {{vars.lead_name}}",
        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
        ownerDirectTemplate:
          "HIGH-VALUE Realtor.com lead ($1M+) kept for you — not offered to the team.\n{{vars.lead_name}} {{vars.lead_phone}}"
      }
    ],
    options: { suppressDefaultReply: true }
  };
}

describe("addRetriggerGuard", () => {
  it("adds the inquiry regex + dedupeLeadRuns, and the result stays valid", () => {
    const def = leadFlowDef();
    expect(addRetriggerGuard(def)).toBe(true);
    const parsed = parseAiFlowDefinition(def);
    expect(parsed.trigger).toMatchObject({
      conditions: [
        { type: "contains", value: "rltr.pro" },
        { type: "regex", value: INQUIRY_REGEX, caseInsensitive: true }
      ]
    });
    expect(parsed.options?.dedupeLeadRuns).toBe(true);
    // The existing suppressDefaultReply survives the option merge.
    expect(parsed.options?.suppressDefaultReply).toBe(true);
  });

  it("is idempotent (second run is a no-op)", () => {
    const def = leadFlowDef();
    expect(addRetriggerGuard(def)).toBe(true);
    const frozen = JSON.stringify(def);
    expect(addRetriggerGuard(def)).toBe(false);
    expect(JSON.stringify(def)).toBe(frozen);
  });

  it("still sets the option when the trigger has no conditions array", () => {
    const def = { options: {} } as Record<string, unknown>;
    expect(addRetriggerGuard(def)).toBe(true);
    expect((def.options as Record<string, unknown>).dedupeLeadRuns).toBe(true);
  });

  it("tightened conditions: inquiry and repeat-inquiry relays match, reply relays do not", () => {
    const def = leadFlowDef();
    addRetriggerGuard(def);
    const conditions = (def.trigger as { conditions: TriggerCondition[] }).conditions;
    expect(evaluateTriggerConditions(conditions, INQUIRY_TEXT, "")).toBe(true);
    expect(evaluateTriggerConditions(conditions, REPEAT_TEXT, "")).toBe(true);
    // The exact message that double-routed Jennifer Phillips.
    expect(evaluateTriggerConditions(conditions, REPLY_TEXT, "")).toBe(false);
  });
});

describe("hardenOwnerDirectAlerts", () => {
  it("frames the owner-direct SMS in '*' rows and turns on the 10/30-min nudges", () => {
    const def = leadFlowDef();
    expect(hardenOwnerDirectAlerts(def)).toBe(true);
    const route = (def.steps as Array<Record<string, unknown>>).find((s) => s.id === "s4")!;
    const template = route.ownerDirectTemplate as string;
    expect(template.startsWith(`${STAR_ROW}\n`)).toBe(true);
    expect(template.endsWith(`\n${STAR_ROW}`)).toBe(true);
    expect(template).toContain("HIGH-VALUE Realtor.com lead");
    expect(route.ownerDirectNudges).toBe(true);
    expect(route.offerTemplate).toBe("New lead {{vars.lead_name}}");
    // Still a valid definition afterwards.
    parseAiFlowDefinition(def);
  });

  it("is idempotent — an already-hardened step is left byte-identical", () => {
    const def = leadFlowDef();
    hardenOwnerDirectAlerts(def);
    const frozen = JSON.stringify(def);
    expect(hardenOwnerDirectAlerts(def)).toBe(false);
    expect(JSON.stringify(def)).toBe(frozen);
  });

  it("reaches route_to_team steps nested in branch arms and else lists", () => {
    const def = {
      steps: [
        {
          id: "b",
          type: "branch",
          branches: [
            {
              id: "arm",
              steps: [
                { id: "r1", type: "route_to_team", ownerDirectTemplate: "keep A" }
              ]
            }
          ],
          else: [{ id: "r2", type: "route_to_team", ownerDirectTemplate: "keep B" }]
        }
      ]
    } as Record<string, unknown>;
    expect(hardenOwnerDirectAlerts(def)).toBe(true);
    const branch = (def.steps as Array<Record<string, unknown>>)[0];
    const arm = (branch.branches as Array<{ steps: Array<Record<string, unknown>> }>)[0];
    expect(arm.steps[0].ownerDirectTemplate).toBe(`${STAR_ROW}\nkeep A\n${STAR_ROW}`);
    expect(arm.steps[0].ownerDirectNudges).toBe(true);
    const elseStep = (branch.else as Array<Record<string, unknown>>)[0];
    expect(elseStep.ownerDirectTemplate).toBe(`${STAR_ROW}\nkeep B\n${STAR_ROW}`);
    expect(elseStep.ownerDirectNudges).toBe(true);
  });

  it("skips steps without a keep-for-owner rule", () => {
    const def = {
      steps: [
        { id: "r1", type: "route_to_team" },
        { id: "r2", type: "route_to_team", ownerDirectTemplate: "   " },
        { id: "s", type: "send_sms", to: "x", body: "not a route step" }
      ]
    } as Record<string, unknown>;
    expect(hardenOwnerDirectAlerts(def)).toBe(false);
  });
});

describe("replyForwardDefinition", () => {
  it("parses; browses the rltr.pro link with the Realtor.com login; forwards to the lead's owner", () => {
    const def = parseAiFlowDefinition(replyForwardDefinition());
    expect(def.options?.suppressDefaultReply).toBe(true);
    expect(def.steps.map((s) => s.type)).toEqual([
      "extract_text",
      "extract_url",
      "browse_extract",
      "notify_lead_owner"
    ]);
    const browse = def.steps[2] as {
      auth?: { integrationLabel: string };
      fields?: Array<{ name: string }>;
    };
    // The relay is always truncated: the FULL message comes from the page,
    // through the stored credentialed session (login when needed).
    expect(browse.auth?.integrationLabel).toBe(REALTOR_INTEGRATION_LABEL);
    expect(browse.fields?.map((f) => f.name)).toEqual(["full_message", "lead_phone"]);
    const forward = def.steps[3] as {
      phoneVar?: string;
      nameVar?: string;
      message: string;
    };
    expect(forward.phoneVar).toBe("lead_phone");
    expect(forward.nameVar).toBe("lead_name");
    expect(forward.message).toContain("{{vars.full_message}}");
    // The truncated relay text rides along so an empty extraction still
    // delivers something actionable.
    expect(forward.message).toContain("{{trigger.windowText}}");
  });

  it("matches ONLY the reply relays the lead flow now ignores (no overlap, no gap)", () => {
    const def = parseAiFlowDefinition(replyForwardDefinition());
    const conditions = (def.trigger as { conditions: TriggerCondition[] }).conditions;
    expect(evaluateTriggerConditions(conditions, REPLY_TEXT, "")).toBe(true);
    expect(evaluateTriggerConditions(conditions, INQUIRY_TEXT, "")).toBe(false);
    expect(evaluateTriggerConditions(conditions, REPEAT_TEXT, "")).toBe(false);
  });

  it("exports stable flow names for the name-keyed idempotency checks", () => {
    expect(LEAD_FLOW_NAME).toBe("Realtor.com Lead");
    expect(REPLY_FLOW_NAME).toBe("Realtor.com Reply — forward to lead owner");
  });
});
