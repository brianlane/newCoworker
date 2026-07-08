import { describe, expect, it } from "vitest";
import { metaLeadFollowUpTemplate } from "@/lib/ai-flows/templates";
import { parseAiFlowDefinition, summarizeDefinition } from "@/lib/ai-flows/schema";

describe("metaLeadFollowUpTemplate", () => {
  it("is a valid definition the install route can persist as-is", () => {
    const tpl = metaLeadFollowUpTemplate();
    // parseAiFlowDefinition throws on any shape or semantic issue — this is
    // the guard that the one-click install can never 400 on our own template.
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("webhook");
    expect(tpl.key).toBe("meta_lead_follow_up");
    expect(tpl.name.length).toBeGreaterThan(0);
  });

  it("extracts the lead, files it, texts back, and briefs the owner — in that order", () => {
    const def = metaLeadFollowUpTemplate().definition;
    expect(def.steps.map((s) => s.type)).toEqual([
      "extract_text",
      "upsert_customer",
      "send_sms",
      "notify_owner"
    ]);
    expect(summarizeDefinition(def)).toContain("When any webhook event arrives");
  });
});
