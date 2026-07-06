import { describe, expect, it } from "vitest";
import {
  addPassOptionCopy,
  PASS_REASON_HINT_LINE
} from "../scripts/oneshot/add-pass-option-copy";
import { parseAiFlowDefinition } from "../src/lib/ai-flows/schema";

function routeDef(offer: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
    steps: [
      {
        id: "route",
        type: "route_to_team",
        agentName: "Dave Lane",
        offerTemplate: offer,
        responseMinutes: 5,
        ownerFallbackTemplate: "Back to you.",
        ...extra
      }
    ]
  };
}

describe("addPassOptionCopy", () => {
  it("rewrites the legacy HomeLight confirm line to claim/pass and appends the reason hint", () => {
    const def = routeDef(
      "New HomeLight referral.\n" +
        "Reply 1 to confirm you're taking it by {{offer.deadline}}.\n" +
        'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out ' +
        '(e.g. "1, 20 min").'
    );
    expect(addPassOptionCopy(def)).toBe(true);
    const offer = (def.steps[0] as { offerTemplate: string }).offerTemplate;
    expect(offer).toContain("Reply 1 to claim or 2 to pass by {{offer.deadline}}.");
    expect(offer).not.toContain("Reply 1 to confirm you're taking it");
    expect(offer).toContain(PASS_REASON_HINT_LINE);
    // The existing universal ETA hint survives.
    expect(offer).toContain('"1, <ETA>"');
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("appends the reason hint to an offer that already advertises 2 to pass", () => {
    const def = routeDef(
      "New lead. Reply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent."
    );
    expect(addPassOptionCopy(def)).toBe(true);
    const offer = (def.steps[0] as { offerTemplate: string }).offerTemplate;
    expect(offer.endsWith(PASS_REASON_HINT_LINE)).toBe(true);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent (second run is a no-op)", () => {
    const def = routeDef("Reply 1 to claim or 2 to pass by {{offer.deadline}}.");
    expect(addPassOptionCopy(def)).toBe(true);
    const once = JSON.stringify(def);
    expect(addPassOptionCopy(def)).toBe(false);
    expect(JSON.stringify(def)).toBe(once);
  });

  it("leaves an offer without a pass option untouched", () => {
    const def = routeDef("Take this lead by {{offer.deadline}} — reply 1 to claim.");
    const before = JSON.stringify(def);
    expect(addPassOptionCopy(def)).toBe(false);
    expect(JSON.stringify(def)).toBe(before);
  });

  it("ignores non-route steps", () => {
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [{ id: "url", type: "extract_url", saveAs: "lead_url" }]
    };
    expect(addPassOptionCopy(def)).toBe(false);
  });
});
