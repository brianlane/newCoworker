import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { DAVE_NAME, FIRST_TO_CLAIM_LINE, GABRIELLE_NAME } from "../scripts/oneshot/amy-speed-to-lead-definition";
import {
  BUYER_BROADCAST,
  CLAIMED_NOTIFY_TEMPLATE,
  FOLLOWUP_TAG,
  JASON_NAME,
  OFFER_TEMPLATE,
  OWNER_FALLBACK_TEMPLATE,
  RESPONSE_MINUTES,
  SELLER_BROADCAST,
  buildFollowupRequestDefinition
} from "../scripts/oneshot/amy-followup-request-definition";

/**
 * The follow-up-request flow for unclaimed leads (Amy's ask, Aug 10 2026):
 * seller/both leads race Dave + Gabby, buyers add Jason, Amy is the owner
 * fallback and never in a broadcast list, and the offer carries the requested
 * asterisk emphasis. Validated through the same parser the dashboard uses so
 * the seed script can never insert a definition the product would reject.
 */

function build() {
  return parseAiFlowDefinition(buildFollowupRequestDefinition());
}

function routeStep(id: string) {
  const def = build();
  const step = def.steps.find((s) => s.id === id);
  if (step?.type !== "route_to_team") throw new Error(`${id} is not a route_to_team step`);
  return step;
}

describe("buildFollowupRequestDefinition", () => {
  it("parses through the product schema", () => {
    const def = build();
    expect(def.version).toBe(1);
    expect(def.steps).toHaveLength(3);
  });

  it("starts when the follow-up tag is added", () => {
    const def = build();
    expect(def.trigger).toEqual({
      channel: "tag_changed",
      tag: FOLLOWUP_TAG,
      change: "added",
      conditions: []
    });
  });

  it("honors a custom tag without changing anything else", () => {
    const def = parseAiFlowDefinition(buildFollowupRequestDefinition({ tag: "Callback Due" }));
    expect(def.trigger).toMatchObject({ channel: "tag_changed", tag: "Callback Due" });
  });

  it("extracts every var the route templates render, with non-empty fallbacks", () => {
    const def = build();
    const extract = def.steps[0];
    if (extract.type !== "extract_text") throw new Error("first step is not extract_text");
    const byName = new Map(extract.fields.map((f) => [f.name, f.description ?? ""]));
    for (const name of ["lead_name", "lead_phone", "route_lead_type", "followup_note"]) {
      expect(byName.has(name), `missing extract field ${name}`).toBe(true);
    }
    // Route templates render with no collapseEmpty, so the gate and note
    // fields must define what to write when the text is silent.
    expect(byName.get("route_lead_type")).toContain('"seller"');
    expect(byName.get("followup_note")).toContain('"a follow-up"');
  });

  it("races Dave and Gabby for sellers, adds Jason for buyers, never Amy", () => {
    expect(SELLER_BROADCAST).toEqual([DAVE_NAME, GABRIELLE_NAME]);
    expect(BUYER_BROADCAST).toEqual([DAVE_NAME, GABRIELLE_NAME, JASON_NAME]);
    expect(routeStep("route_buyer").agentNames).toEqual(BUYER_BROADCAST);
    expect(routeStep("route_seller").agentNames).toEqual(SELLER_BROADCAST);
    for (const id of ["route_buyer", "route_seller"]) {
      expect(routeStep(id).agentNames).not.toContain("Amy Laidlaw");
    }
  });

  it("gates the two routes as an exhaustive either/or on route_lead_type", () => {
    expect(routeStep("route_buyer").when).toEqual({ var: "route_lead_type", equals: "buyer" });
    expect(routeStep("route_seller").when).toEqual({
      var: "route_lead_type",
      notEquals: "buyer"
    });
  });

  it("stars the offer and keeps the house claim mechanics", () => {
    // The asterisks are the point of the Aug 10 ask, not decoration.
    expect(OFFER_TEMPLATE).toContain("*Follow-up requested*");
    expect(OFFER_TEMPLATE).toContain("*today*");
    expect(OFFER_TEMPLATE).toContain("Reply *1* to claim or *2* to pass");
    expect(OFFER_TEMPLATE).toContain("{{offer.deadline}}");
    expect(OFFER_TEMPLATE.endsWith(FIRST_TO_CLAIM_LINE)).toBe(true);
    for (const id of ["route_buyer", "route_seller"]) {
      const step = routeStep(id);
      expect(step.offerTemplate).toBe(OFFER_TEMPLATE);
      expect(step.ownerFallbackTemplate).toBe(OWNER_FALLBACK_TEMPLATE);
      expect(step.claimedNotifyTemplate).toBe(CLAIMED_NOTIFY_TEMPLATE);
      expect(step.responseMinutes).toBe(RESPONSE_MINUTES);
      expect(step.offerWindow).toMatchObject({ timezone: "America/Phoenix" });
    }
  });

  it("keeps every template free of em dashes", () => {
    for (const template of [OFFER_TEMPLATE, OWNER_FALLBACK_TEMPLATE, CLAIMED_NOTIFY_TEMPLATE]) {
      expect(template).not.toMatch(/—/);
    }
  });
});
