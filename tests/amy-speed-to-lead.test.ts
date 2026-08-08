import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  FIRST_TO_CLAIM_LINE,
  GABRIELLE_NAME,
  SPEED_TO_LEAD_NAMES,
  SPOKE_OWNER_VAR,
  addBroadcastRecipient,
  addReachRotation,
  convertRouteToBroadcast,
  retargetSpokeCheck,
  type Ref
} from "../scripts/oneshot/amy-speed-to-lead-definition";

/**
 * Amy's speed-to-lead conversion (the builders behind
 * amy-speed-to-lead-patch.ts). The fixture templates are the LIVE flows'
 * literal copy as of 2026-08-08, so the rewrite patterns are proven against
 * what production actually says, not a paraphrase.
 */

const DAVE: Ref = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "Dave Lane", source: "employee" };
const GABBY: Ref = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", label: "Gabrielle Mota", source: "employee" };
const AMY: Ref = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "Amy Laidlaw", source: "employee" };
const REFS = { dave: DAVE, gabby: GABBY, amy: AMY };

/** ReferralExchange route_seller's live fallback, verbatim. */
const REFX_FALLBACK =
  "Dave didn't claim the {{vars.lead_type}} lead {{vars.lead_name}} ({{vars.lead_phone}}, email: {{vars.lead_email}}) in {{vars.location}}.\nAddress: {{vars.lead_address}}\nLead source: {{vars.web_source}}";
/** New Lead Intake route_seller's live fallback, verbatim (note "Dave Lane"). */
const NLI_FALLBACK =
  "Dave Lane didn't claim the {{vars.lead_type}} lead {{vars.lead_name}} ({{vars.lead_phone}}, email: {{vars.lead_email}}).\nAddress: {{vars.lead_address}}\nLead source: Amy (direct)";
/** The spoke check's live fallback, verbatim. */
const SPOKE_FALLBACK =
  "{{vars.lead_name}} hasn't been reached yet (no confirmation from Dave Lane), starting weekly AI follow-up calls.\nClever lead {{vars.lead_name}} ({{vars.lead_phone}})\nAddress: {{vars.lead_address}}\nCash offers: {{vars.cash_offers}}";

function routeBase(fallback: string): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "lead" }] },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "name" },
          { name: "lead_phone", description: "phone" },
          { name: "lead_type", description: "type" },
          { name: "lead_email", description: "email" },
          { name: "lead_address", description: "address" },
          { name: "location", description: "city" },
          { name: "web_source", description: "site" }
        ]
      },
      {
        id: "route_seller",
        type: "route_to_team",
        agentName: "Dave Lane",
        responseMinutes: 10,
        offerTemplate:
          'New lead {{vars.lead_name}} ({{vars.lead_phone}})\nReply 1 to claim or 2 to pass by {{offer.deadline}}.\nPassing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").',
        ownerFallbackTemplate: fallback
      }
    ]
  };
}

describe("convertRouteToBroadcast", () => {
  it("converts the Dave pin into the simultaneous trio and parses", () => {
    const def = routeBase(REFX_FALLBACK) as unknown as AiFlowDefinition;
    expect(convertRouteToBroadcast(def, "route_seller")).toBe(true);
    const parsed = parseAiFlowDefinition(def);
    const route = parsed.steps.find((s) => s.id === "route_seller");
    if (route?.type !== "route_to_team") throw new Error("route missing");
    expect(route.agentNames).toEqual(SPEED_TO_LEAD_NAMES);
    expect(route.agentName).toBeUndefined();
    // Three people reading the same text need to know it is a race.
    expect(route.offerTemplate.endsWith(FIRST_TO_CLAIM_LINE)).toBe(true);
  });

  it("rewrites both live fallback variants so the fallback no longer blames Dave alone", () => {
    for (const fallback of [REFX_FALLBACK, NLI_FALLBACK]) {
      const def = routeBase(fallback) as unknown as AiFlowDefinition;
      convertRouteToBroadcast(def, "route_seller");
      const route = def.steps.find((s) => s.id === "route_seller") as unknown as Record<string, string>;
      expect(route.ownerFallbackTemplate.startsWith("Nobody claimed the ")).toBe(true);
      expect(route.ownerFallbackTemplate).not.toContain("Dave");
      // Only the lead-in changed; the details survive intact.
      expect(route.ownerFallbackTemplate).toContain("{{vars.lead_address}}");
    }
  });

  it("is a genuine no-op the second time", () => {
    const def = routeBase(REFX_FALLBACK) as unknown as AiFlowDefinition;
    convertRouteToBroadcast(def, "route_seller");
    expect(convertRouteToBroadcast(def, "route_seller")).toBe(false);
  });

  it("refuses a missing or non-route step", () => {
    const def = routeBase(REFX_FALLBACK) as unknown as AiFlowDefinition;
    expect(() => convertRouteToBroadcast(def, "gone")).toThrow(/re-read it before patching/);
    expect(() => convertRouteToBroadcast(def, "extract")).toThrow(/not route_to_team/);
  });
});

describe("addBroadcastRecipient (HomeLight)", () => {
  it("adds Gabrielle to the existing pair, once", () => {
    const def = routeBase(REFX_FALLBACK) as unknown as AiFlowDefinition;
    const route = def.steps.find((s) => s.id === "route_seller") as unknown as Record<string, unknown>;
    delete route.agentName;
    route.agentNames = ["Dave Lane", "Amy Laidlaw"];
    expect(addBroadcastRecipient(def, "route_seller", GABRIELLE_NAME)).toBe(true);
    expect(route.agentNames).toEqual(["Gabrielle Mota", "Dave Lane", "Amy Laidlaw"]);
    expect(addBroadcastRecipient(def, "route_seller", GABRIELLE_NAME)).toBe(false);
    parseAiFlowDefinition(def);
  });

  it("refuses a step with no broadcast to extend", () => {
    const def = routeBase(REFX_FALLBACK) as unknown as AiFlowDefinition;
    expect(() => addBroadcastRecipient(def, "route_seller", GABRIELLE_NAME)).toThrow(
      /no agentNames broadcast/
    );
  });
});

describe("addReachRotation", () => {
  function callBase(): AiFlowDefinition {
    return {
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "lead" }] },
      steps: [
        {
          id: "extract",
          type: "extract_text",
          fields: [{ name: "lead_phone", description: "phone" }]
        },
        {
          id: "ai_call_1",
          type: "place_ai_call",
          toVar: "lead_phone",
          personaTemplate: "Hi there",
          notifyRef: DAVE,
          reachTeammate: { refs: [DAVE, AMY], ringSeconds: 20 }
        }
      ]
    } as unknown as AiFlowDefinition;
  }

  it("swaps the ladder to the rotating trio and the summary to first-target, then no-ops", () => {
    const def = callBase();
    expect(addReachRotation(def, REFS)).toBe(true);
    const parsed = parseAiFlowDefinition(def);
    const call = parsed.steps.find((s) => s.id === "ai_call_1");
    if (call?.type !== "place_ai_call") throw new Error("call missing");
    expect(call.reachTeammate?.refs).toEqual([DAVE, GABBY, AMY]);
    expect(call.reachTeammate?.rotateFirst).toBe(2);
    // The existing ring seconds survive the swap.
    expect(call.reachTeammate?.ringSeconds).toBe(20);
    expect(call.notifyFirstReachTarget).toBe(true);
    expect(call.notifyRef).toBeUndefined();
    expect(addReachRotation(def, REFS)).toBe(false);
  });
});

describe("retargetSpokeCheck", () => {
  function spokeBase(): AiFlowDefinition {
    return {
      version: 1,
      trigger: { channel: "owner_assigned", conditions: [{ type: "contains", value: "clever" }] },
      steps: [
        {
          id: "read_contact",
          type: "extract_text",
          fields: [
            { name: "lead_name", description: "name" },
            { name: "lead_phone", description: "phone" },
            { name: "lead_address", description: "address" },
            { name: "cash_offers", description: "cash offers" }
          ]
        },
        {
          id: "spoke_check",
          type: "route_to_team",
          agentName: "Dave Lane",
          responseMinutes: 1440,
          offerTemplate: "Did you speak with {{vars.lead_name}}? Reply 1 = YES, 2 = not yet.",
          ownerFallbackTemplate: SPOKE_FALLBACK
        },
        {
          id: "week_1_call",
          type: "place_ai_call",
          toVar: "lead_phone",
          personaTemplate: "Hi, following up",
          notifyRef: DAVE,
          contextTemplate:
            "Their name: {{vars.lead_name}}. The team member who will speak with them: Dave Lane.",
          when: { var: "claimed_agent", equals: "none" }
        }
      ]
    } as unknown as AiFlowDefinition;
  }

  it("pins the check to the claimer var, extracts it, neutralizes the copy, then no-ops", () => {
    const def = spokeBase();
    expect(retargetSpokeCheck(def)).toBe(true);
    const parsed = parseAiFlowDefinition(def);
    const read = parsed.steps.find((s) => s.id === "read_contact");
    if (read?.type !== "extract_text") throw new Error("read missing");
    expect(read.fields.some((f) => f.name === SPOKE_OWNER_VAR)).toBe(true);
    const route = parsed.steps.find((s) => s.id === "spoke_check");
    if (route?.type !== "route_to_team") throw new Error("route missing");
    expect(route.agentNameVar).toBe(SPOKE_OWNER_VAR);
    expect(route.agentName).toBeUndefined();
    // Neutral copy: templates never interpolate the var (they do not
    // collapse empties, and grace-parked runs never extracted it).
    expect(route.ownerFallbackTemplate).toContain("no confirmation from the assigned teammate");
    expect(route.ownerFallbackTemplate).not.toContain("Dave Lane");
    const call = parsed.steps.find((s) => s.id === "week_1_call");
    if (call?.type !== "place_ai_call") throw new Error("call missing");
    expect(call.contextTemplate).toContain("A team member is standing by");
    expect(call.contextTemplate).not.toContain("Dave Lane");
    expect(retargetSpokeCheck(def)).toBe(false);
  });
});

describe("no em dashes in anything the builders write", () => {
  it("every rewritten template is clean", () => {
    const def = routeBase(REFX_FALLBACK) as unknown as AiFlowDefinition;
    convertRouteToBroadcast(def, "route_seller");
    expect(JSON.stringify(def).includes("\u2014")).toBe(false);
  });
});
