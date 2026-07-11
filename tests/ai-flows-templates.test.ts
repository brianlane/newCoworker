import { describe, expect, it } from "vitest";
import { metaLeadFollowUpTemplate, priceSheetShareTemplate } from "@/lib/ai-flows/templates";
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

describe("priceSheetShareTemplate", () => {
  const DOC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("is a valid definition once parameterized with the owner's document", () => {
    const tpl = priceSheetShareTemplate(DOC_ID, "Summer price list");
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("sms");
    expect(tpl.key).toBe("price_sheet_share");
  });

  it("shares the picked document with the texter then briefs the owner", () => {
    const def = priceSheetShareTemplate(DOC_ID, "Summer price list").definition;
    expect(def.steps.map((s) => s.type)).toEqual(["share_document", "notify_owner"]);
    const share = def.steps[0];
    if (share.type === "share_document") {
      expect(share.documentId).toBe(DOC_ID);
      expect(share.documentTitle).toBe("Summer price list");
      expect(share.to).toBe("{{trigger.from}}");
      expect(share.messageTemplate).toContain("{{share_url}}");
    }
  });
});
