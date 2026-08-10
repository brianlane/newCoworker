import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  AMY_REMINDER_FLOWS,
  AMY_REMINDER_INTERVAL_MINUTES,
  AMY_REMINDER_ROUNDS,
  addUnclaimedReminders
} from "../scripts/oneshot/amy-unclaimed-reminders-definition";

/**
 * The builder behind amy-unclaimed-reminders-patch.ts. The fixture mirrors the
 * live shape of Amy's lead flows as of 2026-08-10: route steps at the top
 * level AND inside branch arms (ReferralExchange and New Lead Intake both
 * branch buyer / seller / both), so the walk is proven against the nesting it
 * will actually meet.
 */

function fixture(): AiFlowDefinition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "lead" }] },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "name" },
          // The gate the branch below reads, and the var the reminder detail
          // line renders: the schema rejects a template or condition naming a
          // var no earlier step produces, so both must be real here.
          { name: "route_lead_type", description: "buyer or seller" },
          { name: "lead_address", description: "property address" }
        ]
      },
      {
        id: "route_top",
        type: "route_to_team",
        agentName: "Dave Lane",
        responseMinutes: 10,
        offerTemplate: "New lead. Reply 1 to claim by {{offer.deadline}}.",
        ownerFallbackTemplate: "Nobody claimed it."
      },
      {
        id: "fork",
        type: "branch",
        question: "buyer or seller?",
        branches: [
          {
            id: "buyer",
            label: "Buyer",
            condition: { var: "route_lead_type", equals: "buyer" },
            steps: [
              {
                id: "route_buyer",
                type: "route_to_team",
                agentNames: ["Dave Lane", "Gabrielle Mota", "Jason Lane"],
                responseMinutes: 10,
                offerTemplate: "Buyer lead. Reply 1 by {{offer.deadline}}.",
                ownerFallbackTemplate: "Nobody claimed the buyer."
              }
            ]
          }
        ],
        else: [
          {
            id: "route_seller",
            type: "route_to_team",
            agentNames: ["Dave Lane", "Gabrielle Mota"],
            responseMinutes: 10,
            offerTemplate: "Seller lead. Reply 1 by {{offer.deadline}}.",
            ownerFallbackTemplate: "Nobody claimed the seller."
          }
        ]
      }
    ]
  } as unknown as AiFlowDefinition;
}

function routeStep(def: AiFlowDefinition, id: string): Record<string, unknown> {
  let found: Record<string, unknown> | undefined;
  const walk = (steps: unknown[]): void => {
    for (const raw of steps ?? []) {
      const st = raw as Record<string, unknown>;
      if (st.id === id) found = st;
      if (st.type === "branch") {
        for (const arm of (st.branches as { steps: unknown[] }[]) ?? []) walk(arm.steps);
        walk((st.else as unknown[]) ?? []);
      }
    }
  };
  walk(def.steps as unknown[]);
  if (!found) throw new Error(`step ${id} not found`);
  return found;
}

describe("addUnclaimedReminders", () => {
  it("reaches route steps at the top level and inside branch arms", () => {
    const def = fixture();
    const changed = addUnclaimedReminders(def, { detailsTemplate: "Address: {{vars.lead_address}}" });
    expect(changed.sort()).toEqual(["route_buyer", "route_seller", "route_top"]);
  });

  it("applies Amy's numbers and keeps the definition valid", () => {
    const def = fixture();
    addUnclaimedReminders(def, { detailsTemplate: "Address: {{vars.lead_address}}" });
    const parsed = parseAiFlowDefinition(def);
    for (const id of ["route_top", "route_buyer", "route_seller"]) {
      expect(routeStep(parsed, id).unclaimedReminders).toEqual({
        rounds: AMY_REMINDER_ROUNDS,
        intervalMinutes: AMY_REMINDER_INTERVAL_MINUTES,
        detailsTemplate: "Address: {{vars.lead_address}}"
      });
    }
  });

  it("touches every routing mode, not just broadcasts", () => {
    // route_top pins one teammate; her ask covered routing AND broadcasting.
    const def = fixture();
    addUnclaimedReminders(def);
    expect(routeStep(def, "route_top").unclaimedReminders).toBeDefined();
  });

  it("is idempotent: a second pass reports nothing changed", () => {
    const def = fixture();
    const opts = { detailsTemplate: "Address: {{vars.lead_address}}" };
    expect(addUnclaimedReminders(def, opts)).toHaveLength(3);
    expect(addUnclaimedReminders(def, opts)).toEqual([]);
  });

  it("re-patches when the configured numbers change", () => {
    const def = fixture();
    addUnclaimedReminders(def);
    expect(addUnclaimedReminders(def, { rounds: 2 })).toHaveLength(3);
    expect(routeStep(def, "route_top").unclaimedReminders).toMatchObject({ rounds: 2 });
  });

  it("omits detailsTemplate entirely when none is configured", () => {
    const def = fixture();
    addUnclaimedReminders(def);
    expect(routeStep(def, "route_top").unclaimedReminders).toEqual({
      rounds: AMY_REMINDER_ROUNDS,
      intervalMinutes: AMY_REMINDER_INTERVAL_MINUTES
    });
  });

  it("leaves non-routing steps alone", () => {
    const def = fixture();
    addUnclaimedReminders(def);
    expect(routeStep(def, "extract").unclaimedReminders).toBeUndefined();
  });
});

describe("AMY_REMINDER_FLOWS", () => {
  it("covers every one of her flows that routes to the team", () => {
    expect(AMY_REMINDER_FLOWS.map((f) => f.name)).toEqual([
      "Clever Lead - Accept",
      "ReferralExchange Lead",
      "HomeLight Referral",
      "Realtor.com Lead",
      "New Lead Intake",
      "Clever - Spoke Check & Weekly Call Follow-Up",
      "Follow Up Requested (Unclaimed Leads)"
    ]);
  });

  it("gives each flow reminder context built from vars that flow actually has", () => {
    const byName = new Map(AMY_REMINDER_FLOWS.map((f) => [f.name, f.detailsTemplate ?? ""]));
    expect(byName.get("Clever - Spoke Check & Weekly Call Follow-Up")).toContain("cash_offers");
    expect(byName.get("Follow Up Requested (Unclaimed Leads)")).toContain("followup_note");
    expect(byName.get("HomeLight Referral")).toContain("lead_address");
  });

  it("keeps every reminder detail line free of em dashes", () => {
    for (const flow of AMY_REMINDER_FLOWS) {
      expect(flow.detailsTemplate ?? "").not.toMatch(/—/);
    }
  });
});
