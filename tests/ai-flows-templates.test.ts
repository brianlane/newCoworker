import { describe, expect, it } from "vitest";
import {
  cleanReviewLink,
  documentReceiptTemplate,
  instagramCommentTemplate,
  INSTAGRAM_COMMENT_SOURCE,
  instagramProspectTemplate,
  INSTAGRAM_PROSPECT_TAG,
  INSTAGRAM_SCRAPER_SOURCE,
  LIBRARY_STARTER_CATEGORY,
  libraryStarterTemplates,
  META_LEAD_ADS_SOURCE,
  metaLeadFollowUpTemplate,
  newLeadIntakeTemplate,
  priceSheetShareTemplate,
  PROSPECT_OUTREACH_SOURCE,
  PROSPECT_TAG,
  prospectOutreachTemplate,
  reviewRequestTemplate,
  REVIEW_LINK_MAX_LENGTH
} from "@/lib/ai-flows/templates";
import {
  MAX_EXTRACT_FIELDS,
  parseAiFlowDefinition,
  summarizeDefinition
} from "@/lib/ai-flows/schema";
import { evaluateTriggerConditions } from "@/lib/ai-flows/trigger-eval";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import { containsLikelyPii, templateKeyFromName } from "@/lib/ai-flows/scrub";

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
    expect(summarizeDefinition(def)).toContain("When a webhook event matches 1 condition(s)");
  });

  it("briefs the owner cleanly even when the lead left phone/email blank", () => {
    // Live artifact from the Zapier publish test: "New Meta ad lead: Zapier
    // Publish Test - /. Details: none." Meta lead forms routinely carry a
    // phone OR an email, not both, and notify_owner renders with
    // collapseEmpty, which drops whitespace before an empty var but cannot
    // remove punctuation separators around one. So the brief's separators
    // must be whitespace, not ", " and " / ".
    const def = metaLeadFollowUpTemplate().definition;
    const notify = def.steps.find((s) => s.type === "notify_owner");
    expect(notify).toBeTruthy();
    const plan = planStep(notify as never, {
      vars: { lead_name: "Bobby", lead_phone: "", lead_email: "", lead_notes: "none" }
    });
    expect(plan.ok).toBe(true);
    const message = (plan as { action: { message: string } }).action.message;
    expect(message).toContain("Bobby");
    expect(message).toContain("none");
    for (const dangling of [" / ", "/.", " ,", ",.", ", .", "  ", ": ."]) {
      expect(message, `dangling separator ${JSON.stringify(dangling)} in: ${message}`).not.toContain(
        dangling
      );
    }
  });

  it("only fires for the facebook_lead_ads source — it auto-texts, so scraped prospects must never reach it", () => {
    const def = metaLeadFollowUpTemplate().definition;
    expect(def.trigger).toMatchObject({
      channel: "webhook",
      conditions: [{ type: "from_matches", value: META_LEAD_ADS_SOURCE }]
    });
    const conditions = "conditions" in def.trigger ? def.trigger.conditions : [];
    expect(evaluateTriggerConditions(conditions, "any text", "facebook_lead_ads")).toBe(true);
    expect(evaluateTriggerConditions(conditions, "any text", INSTAGRAM_SCRAPER_SOURCE)).toBe(false);
  });
});

describe("instagramProspectTemplate", () => {
  it("is a valid definition the install route can persist as-is", () => {
    const tpl = instagramProspectTemplate();
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("webhook");
    expect(tpl.key).toBe("instagram_prospect_intake");
    expect(tpl.name.length).toBeGreaterThan(0);
  });

  it("only fires for the instagram_scraper source label", () => {
    const def = instagramProspectTemplate().definition;
    expect(def.trigger).toMatchObject({
      channel: "webhook",
      conditions: [{ type: "from_matches", value: INSTAGRAM_SCRAPER_SOURCE }]
    });
    const conditions = "conditions" in def.trigger ? def.trigger.conditions : [];
    // The webhook channel evaluates from_matches against the caller-supplied
    // source label — the guide's suggested label matches, others don't.
    expect(evaluateTriggerConditions(conditions, "any text", "instagram_scraper")).toBe(true);
    expect(evaluateTriggerConditions(conditions, "any text", "facebook_lead_ads")).toBe(false);
  });

  it("extracts, briefs the owner FIRST, then files + tags the prospect — never texts or emails", () => {
    const def = instagramProspectTemplate().definition;
    // The brief precedes the phone-gated filing so it always reaches the
    // owner and can never claim a contact/tag a skipped step didn't create.
    expect(def.steps.map((s) => s.type)).toEqual([
      "extract_text",
      "notify_owner",
      "upsert_customer",
      "update_contact"
    ]);
    // Compliance invariant: scraped prospects never consented, so the starter
    // must not carry any outbound-contact step.
    expect(def.steps.some((s) => s.type === "send_sms" || s.type === "send_email")).toBe(false);
    const tag = def.steps[3];
    if (tag.type === "update_contact") {
      expect(tag.addTags).toEqual([INSTAGRAM_PROSPECT_TAG]);
    }
  });

  it("gates the phone-keyed file + tag steps on a usable phone", () => {
    const def = instagramProspectTemplate().definition;
    const file = def.steps[2];
    const tag = def.steps[3];
    // The CRM is phone-keyed; a scraped profile often has only email/handle.
    // Both steps skip cleanly on 'none' instead of failing the run.
    if (file.type === "upsert_customer") {
      expect(file.when).toEqual({ var: "lead_phone", notEquals: "none" });
    }
    if (tag.type === "update_contact") {
      expect(tag.when).toEqual({ var: "lead_phone", notEquals: "none" });
    }
    // The extractor is told the exact sentinel — 'none', never an empty
    // string — because the when-guards test for it literally.
    const extract = def.steps[0];
    if (extract.type === "extract_text") {
      const phoneField = extract.fields.find((f) => f.name === "lead_phone");
      expect(phoneField?.description).toContain("'none'");
      expect(phoneField?.description).toContain("not an empty string");
    }
  });

  it("briefs the owner unconditionally with the handle + email, without claiming a filing", () => {
    const def = instagramProspectTemplate().definition;
    const notify = def.steps[1];
    if (notify.type === "notify_owner") {
      expect(notify.when).toBeUndefined();
      expect(notify.message).toContain("{{vars.lead_handle}}");
      expect(notify.message).toContain("{{vars.lead_email}}");
      // The brief must not assert "filed and tagged" — phone-less profiles
      // skip those steps (Bugbot 0d7238c4).
      expect(notify.message).not.toMatch(/filed and tagged/i);
      expect(notify.message).toContain("If their profile has a phone number");
    }
  });
});

describe("prospectOutreachTemplate", () => {
  it("is a valid definition the install route can persist as-is", () => {
    const tpl = prospectOutreachTemplate();
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("webhook");
    expect(tpl.key).toBe("prospect_outreach_follow_through");
    expect(tpl.name.length).toBeGreaterThan(0);
  });

  it("only fires for the prospect_outreach source label", () => {
    const def = prospectOutreachTemplate().definition;
    expect(def.trigger).toMatchObject({
      channel: "webhook",
      conditions: [{ type: "from_matches", value: PROSPECT_OUTREACH_SOURCE }]
    });
    const conditions = "conditions" in def.trigger ? def.trigger.conditions : [];
    expect(evaluateTriggerConditions(conditions, "any text", PROSPECT_OUTREACH_SOURCE)).toBe(true);
    expect(evaluateTriggerConditions(conditions, "any text", INSTAGRAM_SCRAPER_SOURCE)).toBe(false);
  });

  it("carries NO send step: the pitch and its compliance footer are sent in code", () => {
    const def = prospectOutreachTemplate().definition;
    expect(def.steps.map((s) => s.type)).toEqual([
      "extract_text",
      "upsert_customer",
      "update_contact"
    ]);
    // The invariant: a flow step's body is owner-editable copy, and the pitch
    // carries a legally required unsubscribe link and postal address. Putting
    // the pitch here would make the footer deletable by accident.
    expect(def.steps.some((s) => s.type === "send_email" || s.type === "send_sms")).toBe(false);
  });

  it("says NOTHING to the owner per prospect: filing is not news", () => {
    // notify_owner texts the owner's alert number, so at a cap of twelve a day
    // this flow would send twelve texts announcing that strangers received
    // email. The numbers are on the Marketing page and the reply alert already
    // comes from the email coworker, so the running commentary is pure noise.
    const def = prospectOutreachTemplate().definition;
    expect(def.steps.some((s) => s.type === "notify_owner")).toBe(false);
  });

  it("gates the phone-keyed file + tag steps on a usable phone", () => {
    const def = prospectOutreachTemplate().definition;
    const file = def.steps[1];
    const tag = def.steps[2];
    if (file.type !== "upsert_customer" || tag.type !== "update_contact") {
      throw new Error("expected file then tag");
    }
    expect(file.when).toEqual({ var: "prospect_phone", notEquals: "none" });
    expect(tag.when).toEqual({ var: "prospect_phone", notEquals: "none" });
    expect(tag.addTags).toEqual([PROSPECT_TAG]);
    const extract = def.steps[0];
    if (extract.type === "extract_text") {
      const phone = extract.fields.find((f) => f.name === "prospect_phone");
      expect(phone?.description).toContain("'none'");
      expect(phone?.description).toContain("not an empty string");
      expect(extract.fields.length).toBeLessThanOrEqual(MAX_EXTRACT_FIELDS);
    }
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

  it("extracts the customer, files them, texts the review link, and briefs the owner", () => {
    const def = reviewRequestTemplate(LINK).definition;
    expect(def.steps.map((s) => s.type)).toEqual([
      "extract_text",
      "upsert_customer",
      "send_sms",
      "notify_owner"
    ]);
    const sms = def.steps[2];
    if (sms.type === "send_sms") {
      expect(sms.to).toBe("{{vars.customer_phone}}");
      expect(sms.body).toContain(LINK);
    }
    // The owner brief is gated on a real phone being found ('none' = no text
    // went out, so no "I texted them" claim).
    const notify = def.steps[3];
    if (notify.type === "notify_owner") {
      expect(notify.when).toEqual({ var: "customer_phone", notEquals: "none" });
    }
  });

  it("files the texted attendee as a contact, guarded on a usable phone (the Kav lesson)", () => {
    // A calendar-sourced person the flow texts must get a NAMED contact row,
    // not a bare number the Texts page renders with "Set contact".
    const def = reviewRequestTemplate(LINK).definition;
    const file = def.steps[1];
    if (file.type === "upsert_customer") {
      expect(file.phoneVar).toBe("customer_phone");
      expect(file.nameVar).toBe("customer_name");
      expect(file.when).toEqual({ var: "customer_phone", notEquals: "none" });
    } else {
      throw new Error("expected the filing step right after extraction");
    }
  });
});

describe("documentReceiptTemplate", () => {
  it("is a valid definition the install route can persist as-is", () => {
    const tpl = documentReceiptTemplate();
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("tenant_email");
    expect(tpl.key).toBe("document_receipt_confirmation");
    expect(tpl.name.length).toBeGreaterThan(0);
  });

  it("fires only on mail carrying attachments (anchored to the appended marker line)", () => {
    const def = documentReceiptTemplate().definition;
    expect(def.trigger).toMatchObject({
      channel: "tenant_email",
      conditions: [{ type: "regex", value: "\\n\\[inbound attachments\\] .+$" }]
    });
    const pattern = new RegExp("\\n\\[inbound attachments\\] .+$", "i");
    // Matches the appended marker line…
    expect(pattern.test("subject\nbody\n\n[inbound attachments] license.pdf")).toBe(true);
    // …but not prose that merely mentions attachments.
    expect(pattern.test("subject\nSee the attachments: license.pdf\nthanks")).toBe(false);
  });

  it("confirms to the sender naming the files, then briefs the owner", () => {
    const def = documentReceiptTemplate().definition;
    expect(def.steps.map((s) => s.type)).toEqual(["send_email", "notify_owner"]);
    const confirm = def.steps[0];
    if (confirm.type === "send_email") {
      expect(confirm.to).toBe("{{trigger.from}}");
      expect(confirm.body).toContain("{{trigger.attachments}}");
    }
    const notify = def.steps[1];
    if (notify.type === "notify_owner") {
      expect(notify.message).toContain("{{trigger.attachments}}");
    }
  });
});

describe("instagramCommentTemplate", () => {
  it("is a valid definition the install route can persist as-is", () => {
    const tpl = instagramCommentTemplate();
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("webhook");
    expect(tpl.key).toBe("instagram_comment_follow_up");
    expect(tpl.summary.length).toBeGreaterThan(20);
  });

  it("fires for instagram_comment and NOT for the other Meta webhook sources", () => {
    const def = instagramCommentTemplate().definition;
    const conditions = "conditions" in def.trigger ? def.trigger.conditions : [];
    expect(evaluateTriggerConditions(conditions, "any text", INSTAGRAM_COMMENT_SOURCE)).toBe(true);
    // A lead and a scraped prospect must not reach a flow written for comments.
    expect(evaluateTriggerConditions(conditions, "any text", META_LEAD_ADS_SOURCE)).toBe(false);
    expect(evaluateTriggerConditions(conditions, "any text", INSTAGRAM_SCRAPER_SOURCE)).toBe(false);
  });

  it("answers ON Instagram and nowhere else: no text, email, or CRM filing", () => {
    // The rule this pins has not changed, only what satisfies it. A commenter
    // gave no consent to be texted or emailed and a comment carries no phone,
    // so anything that reaches them OFF the platform would be both broken and
    // unlawful. Replying where they commented is the one channel they chose.
    const def = instagramCommentTemplate().definition;
    const types = def.steps.map((s) => s.type);
    expect(types).toEqual(["extract_text", "reply_to_comment", "notify_owner"]);
    for (const banned of ["send_sms", "send_email", "send_whatsapp", "upsert_customer"]) {
      expect(types).not.toContain(banned);
    }
  });

  it("replies PUBLICLY, never spending the single private reply", () => {
    // Instagram allows exactly ONE private reply per comment, ever. Spending
    // it on a generic acknowledgement would burn the only message the owner
    // has left for the real answer.
    const reply = instagramCommentTemplate().definition.steps.find(
      (s) => s.type === "reply_to_comment"
    );
    expect((reply as { replyMode: string }).replyMode).toBe("public");
  });

  it("stays quiet under spam, and never claims it cannot reply", () => {
    const def = instagramCommentTemplate().definition;
    const reply = def.steps.find((s) => s.type === "reply_to_comment");
    // A public "thanks!" under a scam comment is worse than silence.
    expect((reply as { when?: { var: string; notEquals?: string } }).when).toEqual({
      var: "comment_intent",
      notEquals: "spam"
    });
    // The brief used to tell the owner we could not reply. We can now.
    const brief = JSON.stringify(def.steps);
    expect(brief).not.toContain("can't reply to comments for you");
  });

  it("leaves no dangling punctuation when a var renders empty", () => {
    // Same rule the Meta starter learned the hard way (the "Bobby, /." alert):
    // vars are separated by whitespace, never by ", " or " / ".
    const notify = instagramCommentTemplate().definition.steps.find(
      (s) => s.type === "notify_owner"
    );
    const message = (notify as { message: string }).message;
    for (const dangling of [", {{", " / {{", "({{vars.commenter_handle}})"]) {
      expect(message).not.toContain(dangling);
    }
  });
});

describe("libraryStarterTemplates", () => {
  it("publishes the four curated starters, review link as a placeholder", () => {
    expect(libraryStarterTemplates().map((t) => t.key)).toEqual([
      "review_request_after_appointment",
      "document_receipt_confirmation",
      "new_lead_intake",
      "instagram_comment_follow_up"
    ]);
    expect(LIBRARY_STARTER_CATEGORY).toBe("Starters");
    const review = libraryStarterTemplates()[0];
    expect(JSON.stringify(review.definition)).toContain("example.invalid/your-review-link");
  });

  it("every starter carries library copy and a definition the duplicate route can persist", () => {
    for (const tpl of libraryStarterTemplates()) {
      expect(tpl.summary.length).toBeGreaterThan(20);
      // The catalog is published verbatim, so the definition must already be
      // valid: there is no scrub/substitution pass to repair structure. The
      // review starter ships a sentinel URL that the use route swaps for the
      // owner's pasted link before createAiFlow.
      expect(() => parseAiFlowDefinition(tpl.definition)).not.toThrow();
      // The catalog slug comes from the NAME, so a tenant who installs the
      // starter from the card groups onto the same entry.
      expect(templateKeyFromName(tpl.name).length).toBeGreaterThan(0);
    }
  });

  it("carries no personal data and no em dashes: it is published unscrubbed", () => {
    for (const tpl of libraryStarterTemplates()) {
      expect(containsLikelyPii(tpl.definition)).toBe(false);
      expect(containsLikelyPii(tpl.summary)).toBe(false);
      expect(`${tpl.name} ${tpl.summary}${JSON.stringify(tpl.definition)}`).not.toContain("\u2014");
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

describe("newLeadIntakeTemplate", () => {
  it("is a valid definition the install route can persist as-is", () => {
    const tpl = newLeadIntakeTemplate();
    const def = parseAiFlowDefinition(tpl.definition);
    expect(def.trigger.channel).toBe("manual");
    expect(tpl.key).toBe("new_lead_intake");
    expect(tpl.name).toBe("New Lead Intake");
  });

  it("parses, files, intro-texts (referral-forked), can call, routes, and briefs the owner", () => {
    const def = newLeadIntakeTemplate().definition;
    expect(def.steps.map((s) => s.type)).toEqual([
      "extract_text",
      "upsert_customer",
      "branch",
      "place_ai_call",
      "route_to_team",
      "notify_owner",
      "notify_owner"
    ]);
    expect(summarizeDefinition(def)).toContain("On demand");
  });

  /**
   * The starter has to work for ANY tenant, which is exactly why the call step
   * needs notifyOwner: the other two summary recipients bake in a phone number
   * or a contact row id.
   */
  it("its call step is tenant-neutral: summary to the owner, no live transfer", () => {
    const def = newLeadIntakeTemplate().definition;
    const call = def.steps.find((s) => s.type === "place_ai_call");
    if (!call || call.type !== "place_ai_call") throw new Error("call step missing");
    expect(call.notifyOwner).toBe(true);
    expect(call.notifyE164).toBeUndefined();
    expect(call.notifyRef).toBeUndefined();
    expect(call.transfer).toBeUndefined();
    expect(call.when).toEqual({ var: "call_gate", equals: "yes" });
    expect(call.toVar).toBe("lead_phone");
  });

  it("stamps the lead's language and separates texting from calling", () => {
    const def = newLeadIntakeTemplate().definition;
    const save = def.steps.find((s) => s.type === "upsert_customer");
    if (!save || save.type !== "upsert_customer") throw new Error("upsert missing");
    expect(save.languageVar).toBe("lead_language");
    const parse = def.steps[0];
    if (parse.type !== "extract_text") throw new Error("extract missing");
    const names = parse.fields.map((f) => f.name);
    for (const required of ["lead_language", "text_gate", "call_gate"]) {
      expect(names).toContain(required);
    }
    expect(parse.fields.length).toBeLessThanOrEqual(MAX_EXTRACT_FIELDS);
    // The intro texts gate on text_gate (which answers none for a call-only
    // request), never on has_phone, so "call this lead" does not also text.
    const intro = def.steps.find((s) => s.type === "branch");
    if (!intro || intro.type !== "branch") throw new Error("intro branch missing");
    const smsSteps = [...intro.branches[0].steps, ...(intro.else ?? [])].filter(
      (s) => s.type === "send_sms"
    );
    expect(smsSteps).toHaveLength(2);
    for (const s of smsSteps) expect(s.when).toEqual({ var: "text_gate", equals: "yes" });
  });

  it("pins DYNAMICALLY to the teammate the owner named (agentNameVar, no static roster)", () => {
    const def = newLeadIntakeTemplate().definition;
    const route = def.steps.find((s) => s.type === "route_to_team");
    expect(route && route.type === "route_to_team" && route.agentNameVar).toBe(
      "assigned_agent"
    );
    // No static pin anywhere: a new hire is pinnable the day they join.
    expect(route && route.type === "route_to_team" && route.agentName).toBeUndefined();
    // The extraction produces the var the pin reads.
    const parse = def.steps[0];
    if (parse.type === "extract_text") {
      expect(parse.fields.map((f) => f.name)).toContain("assigned_agent");
      expect(parse.fields.map((f) => f.name)).toContain("referred_by");
      expect(parse.fields.map((f) => f.name)).toContain("referral_gate");
    }
  });

  it("the referral fork fails CLOSED (equals-matched gate; referrer only in the referral arm)", () => {
    const def = newLeadIntakeTemplate().definition;
    const intro = def.steps.find((s) => s.type === "branch");
    if (!intro || intro.type !== "branch") throw new Error("intro branch missing");
    expect(intro.branches[0].condition).toEqual({ var: "referral_gate", equals: "referral" });
    const armJson = JSON.stringify(intro.branches[0].steps);
    expect(armJson).toContain("{{vars.referred_by}}");
    const elseJson = JSON.stringify(intro.else ?? []);
    expect(elseJson).not.toContain("{{vars.referred_by}}");
  });
});
