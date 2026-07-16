import { describe, expect, it } from "vitest";
import {
  cleanReviewLink,
  metaLeadFollowUpTemplate,
  priceSheetShareTemplate,
  reviewRequestTemplate,
  REVIEW_LINK_MAX_LENGTH
} from "@/lib/ai-flows/templates";
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

describe("cleanReviewLink", () => {
  it("trims, requires http(s), and strips template braces", () => {
    expect(cleanReviewLink("  https://g.page/r/abc/review  ")).toBe(
      "https://g.page/r/abc/review"
    );
    expect(cleanReviewLink("http://reviews.example.com/x")).toBe(
      "http://reviews.example.com/x"
    );
    // Braces are stripped so a pasted value can never smuggle {{vars.x}}.
    expect(cleanReviewLink("https://x.test/{{vars.secret}}")).toBe(
      "https://x.test/vars.secret"
    );
  });

  it("rejects non-links, embedded whitespace, and oversized values", () => {
    expect(cleanReviewLink("")).toBeNull();
    expect(cleanReviewLink("   ")).toBeNull();
    expect(cleanReviewLink("g.page/r/abc")).toBeNull();
    expect(cleanReviewLink("ftp://x.test/review")).toBeNull();
    expect(cleanReviewLink("https://x.test/a b")).toBeNull();
    expect(cleanReviewLink(`https://x.test/${"a".repeat(REVIEW_LINK_MAX_LENGTH)}`)).toBeNull();
  });
});

describe("reviewRequestTemplate", () => {
  const LINK = "https://g.page/r/abc/review";

  it("is a valid definition the install route can persist as-is", () => {
    const tpl = reviewRequestTemplate(LINK);
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("calendar");
    expect(tpl.key).toBe("review_request_after_appointment");
    expect(summarizeDefinition(def)).toContain("after a calendar event ends");
  });

  it("fires an hour after an appointment ends, on both calendars", () => {
    const def = reviewRequestTemplate(LINK).definition;
    expect(def.trigger).toMatchObject({
      channel: "calendar",
      on: "event_end",
      followMinutes: 60,
      calendar: "both"
    });
  });

  it("extracts the customer, texts the review link, and briefs the owner", () => {
    const def = reviewRequestTemplate(LINK).definition;
    expect(def.steps.map((s) => s.type)).toEqual(["extract_text", "send_sms", "notify_owner"]);
    const sms = def.steps[1];
    if (sms.type === "send_sms") {
      expect(sms.to).toBe("{{vars.customer_phone}}");
      expect(sms.body).toContain(LINK);
    }
    // The owner brief is gated on a real phone being found ('none' = no text
    // went out, so no "I texted them" claim).
    const notify = def.steps[2];
    if (notify.type === "notify_owner") {
      expect(notify.when).toEqual({ var: "customer_phone", notEquals: "none" });
    }
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
