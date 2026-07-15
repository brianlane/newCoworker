/**
 * Pure white-glove intake → tenant mapping (src/lib/white-glove/apply.ts).
 * The primary fixture is the real KYP Ads intake (the first white-glove
 * build applied through this pipeline).
 */
import { describe, it, expect } from "vitest";

import {
  buildIntakeApplyPlan,
  compileGreetingPlaceholders,
  firstFollowUpMinutes,
  firstLinkInGreeting,
  handoffAfterAttempts,
  intakeFollowUpFlowTemplate,
  INTAKE_FOLLOW_UP_FLOW_NAME,
  parseIntakeBusinessHours,
  renderIntakeMemorySection,
  renderIntakeSoulSection,
  replaceWhiteGloveBlock,
  secondFollowUpMinutes,
  WHITE_GLOVE_BLOCK_END,
  WHITE_GLOVE_BLOCK_START,
  wrapWhiteGloveBlock
} from "@/lib/white-glove/apply";
import type { IntakeAnswers, IntakeMeta } from "@/lib/white-glove/template";

const KYP_GREETING =
  "Hey {name}, thanks for your interest in KYP Ads! I saw you're in {industry} and " +
  "looking to grow your leads. I'd love to map out a plan for your business on a quick " +
  "free strategy call. You can grab a time here: " +
  "calendly.com/james-kyp-ads/my-free-scale-plan or " +
  "https://calendly.com/james-kyp-ads/kyp-ads-free-strategy-2";

/** The real KYP Ads intake answers (white_glove_intakes 851d0a36…). */
const KYP_ANSWERS: IntakeAnswers = {
  business_hours: "11am to 6pm",
  team: "James - 514-518-8192",
  lead_sources: ["facebook_instagram", "website_form"],
  lead_sources_other: "",
  greeting: KYP_GREETING,
  qualification_questions: "",
  appointment_length: "30",
  appointment_buffer: "none",
  booking_notice: "2h",
  booking_window: "1w",
  first_follow_up: "2h",
  second_follow_up: "next_day",
  handoff_after: "3_attempts",
  never_handle: ["pricing", "complaints", "cancellations", "payments"],
  never_handle_other:
    "Requests involving Meta account access or passwords, any promise of specific " +
    "results or lead guarantees, and questions about advertising restricted categories " +
    "like crypto, supplements, or financial products.",
  consent_confirmed: "yes",
  notes:
    "Main goal is booking qualified leads onto my free strategy call via Calendly, " +
    "that's where I close. Keep the tone casual, warm, and human."
};

const KYP_META: IntakeMeta = { businessName: "Kyp Ads", industry: "other" };

describe("marker block replace", () => {
  it("appends a block to empty and non-empty documents", () => {
    const block = wrapWhiteGloveBlock("content");
    expect(replaceWhiteGloveBlock("", block)).toBe(`${block}\n`);
    expect(replaceWhiteGloveBlock("# soul.md\nOwner text.\n", block)).toBe(
      `# soul.md\nOwner text.\n\n${block}\n`
    );
  });

  it("replaces only its own block, leaving owner text intact (idempotent re-apply)", () => {
    const v1 = wrapWhiteGloveBlock("version one");
    const v2 = wrapWhiteGloveBlock("version two");
    const doc = `# soul.md\nBefore.\n\n${v1}\n\nAfter (owner edit).`;
    const updated = replaceWhiteGloveBlock(doc, v2);
    expect(updated).toContain("version two");
    expect(updated).not.toContain("version one");
    expect(updated).toContain("Before.");
    expect(updated).toContain("After (owner edit).");
    // Re-applying the same block changes nothing further.
    expect(replaceWhiteGloveBlock(updated, v2)).toBe(updated);
  });

  it("treats a start marker without an end as no block (appends fresh)", () => {
    const doc = `Text\n${WHITE_GLOVE_BLOCK_START}\norphaned`;
    const block = wrapWhiteGloveBlock("new");
    const updated = replaceWhiteGloveBlock(doc, block);
    expect(updated.endsWith(`${block}\n`)).toBe(true);
    expect(updated).toContain("orphaned");
  });

  it("wrapWhiteGloveBlock brackets trimmed content with the markers", () => {
    const block = wrapWhiteGloveBlock("\n hello \n");
    expect(block.startsWith(WHITE_GLOVE_BLOCK_START)).toBe(true);
    expect(block.endsWith(WHITE_GLOVE_BLOCK_END)).toBe(true);
    expect(block).toContain("hello");
  });
});

describe("cadence maps", () => {
  it("maps every choice value and defaults unknown values", () => {
    expect(firstFollowUpMinutes("2h")).toBe(120);
    expect(firstFollowUpMinutes("4h")).toBe(240);
    expect(firstFollowUpMinutes("same_day")).toBe(300);
    expect(firstFollowUpMinutes("next_morning")).toBe(1080);
    expect(firstFollowUpMinutes("bogus")).toBe(120);

    expect(secondFollowUpMinutes("next_day")).toBe(1440);
    expect(secondFollowUpMinutes("2d")).toBe(2880);
    expect(secondFollowUpMinutes("3d")).toBe(4320);
    expect(secondFollowUpMinutes("1w")).toBe(10080);
    expect(secondFollowUpMinutes("bogus")).toBe(1440);

    expect(handoffAfterAttempts("2_attempts")).toBe(2);
    expect(handoffAfterAttempts("3_attempts")).toBe(3);
    expect(handoffAfterAttempts("5_attempts")).toBe(5);
    expect(handoffAfterAttempts("bogus")).toBe(3);
  });
});

describe("parseIntakeBusinessHours", () => {
  it("parses KYP's dayless hours onto Monday–Friday", () => {
    expect(parseIntakeBusinessHours("11am to 6pm")).toEqual({
      mon: { open: "11:00", close: "18:00" },
      tue: { open: "11:00", close: "18:00" },
      wed: { open: "11:00", close: "18:00" },
      thu: { open: "11:00", close: "18:00" },
      fri: { open: "11:00", close: "18:00" }
    });
  });

  it("parses day ranges, singles, and multi-segment specs", () => {
    expect(parseIntakeBusinessHours("Mon–Fri 9-5, Sat 10am–2pm")).toEqual({
      mon: { open: "09:00", close: "17:00" },
      tue: { open: "09:00", close: "17:00" },
      wed: { open: "09:00", close: "17:00" },
      thu: { open: "09:00", close: "17:00" },
      fri: { open: "09:00", close: "17:00" },
      sat: { open: "10:00", close: "14:00" }
    });
    expect(parseIntakeBusinessHours("Tuesday and Thursday 8:30am to 12pm")).toEqual({
      tue: { open: "08:30", close: "12:00" },
      thu: { open: "08:30", close: "12:00" }
    });
  });

  it("handles everyday / weekday / weekend keywords and wrap-around ranges", () => {
    expect(parseIntakeBusinessHours("every day 8am-4pm")).toMatchObject({
      mon: { open: "08:00", close: "16:00" },
      sun: { open: "08:00", close: "16:00" }
    });
    expect(parseIntakeBusinessHours("weekdays 9-5")).not.toHaveProperty("sat");
    expect(parseIntakeBusinessHours("weekends 10am to 2pm")).toEqual({
      sat: { open: "10:00", close: "14:00" },
      sun: { open: "10:00", close: "14:00" }
    });
    expect(parseIntakeBusinessHours("Sat to Mon 10-2")).toEqual({
      sat: { open: "10:00", close: "14:00" },
      sun: { open: "10:00", close: "14:00" },
      mon: { open: "10:00", close: "14:00" }
    });
  });

  it("handles 12am/12pm edges, close minutes, and duplicate day mentions", () => {
    expect(parseIntakeBusinessHours("12am to 3am")?.mon).toEqual({
      open: "00:00",
      close: "03:00"
    });
    expect(parseIntakeBusinessHours("10am to 2:30pm")?.mon).toEqual({
      open: "10:00",
      close: "14:30"
    });
    expect(parseIntakeBusinessHours("Mon and Monday 9-5")).toEqual({
      mon: { open: "09:00", close: "17:00" }
    });
  });

  it("infers meridiems: shorthand close rolls past noon, open borrows a valid pm", () => {
    // "9-5" → 09:00–17:00; "9am to 5" → same.
    expect(parseIntakeBusinessHours("9-5")?.mon).toEqual({ open: "09:00", close: "17:00" });
    expect(parseIntakeBusinessHours("9am to 5")?.mon).toEqual({
      open: "09:00",
      close: "17:00"
    });
    // "7 to 9pm" → evening range 19:00–21:00 (borrowing pm keeps it valid).
    expect(parseIntakeBusinessHours("7 to 9pm")?.mon).toEqual({
      open: "19:00",
      close: "21:00"
    });
    // "11 to 6pm" → 11:00–18:00 (borrowing pm would invert the range).
    expect(parseIntakeBusinessHours("11 to 6pm")?.mon).toEqual({
      open: "11:00",
      close: "18:00"
    });
    // A 24h open with a pm close can't borrow (13pm invalid) → literal 13:00.
    expect(parseIntakeBusinessHours("13 to 9pm")?.mon).toEqual({
      open: "13:00",
      close: "21:00"
    });
  });

  it("returns null for unusable text and drops invalid segments", () => {
    expect(parseIntakeBusinessHours("whenever works")).toBeNull();
    expect(parseIntakeBusinessHours("open late")).toBeNull();
    // Inverted / degenerate ranges fail the segment.
    expect(parseIntakeBusinessHours("5pm to 5pm")).toBeNull();
    expect(parseIntakeBusinessHours("13 to 12")).toBeNull();
    expect(parseIntakeBusinessHours("44 to 55")).toBeNull();
    expect(parseIntakeBusinessHours("13pm to 5pm")).toBeNull();
    // Bad minutes fail; a later good segment still parses.
    expect(parseIntakeBusinessHours("9:75-5, sat 10-2")).toEqual({
      sat: { open: "10:00", close: "14:00" }
    });
  });
});

describe("compileGreetingPlaceholders", () => {
  it("maps {name} to the base lead_name var and other tokens to extract fields", () => {
    const out = compileGreetingPlaceholders(KYP_GREETING);
    expect(out.body).toContain("{{vars.lead_name}}");
    expect(out.body).toContain("{{vars.lead_industry}}");
    expect(out.extraFields).toEqual([
      expect.objectContaining({ name: "lead_industry" })
    ]);
  });

  it("reuses a repeated token's field and caps extras at 3", () => {
    const out = compileGreetingPlaceholders("{a} {b} {c} {d} {a}");
    expect(out.extraFields.map((f) => f.name)).toEqual(["lead_a", "lead_b", "lead_c"]);
    // {d} is over the cap → literal text without braces; {a} reused.
    expect(out.body).toBe("{{vars.lead_a}} {{vars.lead_b}} {{vars.lead_c}} d {{vars.lead_a}}");
  });

  it("degrades unusable tokens to their literal text", () => {
    expect(compileGreetingPlaceholders("Hi {!!!}").body).toBe("Hi !!!");
    const tooLong = "x".repeat(40);
    expect(compileGreetingPlaceholders(`Hi {${tooLong}}`).body).toBe(`Hi ${tooLong}`);
    expect(compileGreetingPlaceholders("No placeholders").extraFields).toEqual([]);
  });
});

describe("firstLinkInGreeting", () => {
  it("finds the first (schemeless) link and strips trailing punctuation", () => {
    expect(firstLinkInGreeting(KYP_GREETING)).toBe(
      "calendly.com/james-kyp-ads/my-free-scale-plan"
    );
    expect(firstLinkInGreeting("Book here: https://cal.com/x/intro!")).toBe(
      "https://cal.com/x/intro"
    );
    expect(firstLinkInGreeting("Hi there, no link")).toBeNull();
  });
});

describe("intakeFollowUpFlowTemplate", () => {
  it("builds a valid flow from the KYP answers with the agreed cadence", () => {
    const tpl = intakeFollowUpFlowTemplate(KYP_ANSWERS, KYP_META);
    expect(tpl.key).toBe("white_glove_lead_follow_up");
    expect(tpl.name).toBe(INTAKE_FOLLOW_UP_FLOW_NAME);
    expect(tpl.definition.trigger).toEqual({ channel: "webhook", conditions: [] });

    const ids = tpl.definition.steps.map((s) => s.id);
    // 3 attempts → 3 wait+nudge cycles between the greeting and the flag.
    expect(ids).toEqual([
      "s_extract",
      "s_file",
      "s_greet",
      "s_notify_new",
      "s_wait_1",
      "s_nudge_1",
      "s_wait_2",
      "s_nudge_2",
      "s_wait_3",
      "s_nudge_3",
      "s_wait_final",
      "s_flag_owner",
      "s_mark_inactive",
      "s_goal"
    ]);

    const byId = new Map(tpl.definition.steps.map((s) => [s.id, s as Record<string, unknown>]));
    // Cadence: first nudge after 2h, later ones the next day.
    expect(byId.get("s_wait_1")).toMatchObject({ timeoutMinutes: 120 });
    expect(byId.get("s_wait_2")).toMatchObject({
      timeoutMinutes: 1440,
      when: { var: "reply_1", equals: "no_reply" }
    });
    expect(byId.get("s_wait_1")).not.toHaveProperty("when");
    // Nudges only fire when their wait timed out.
    expect(byId.get("s_nudge_1")).toMatchObject({
      when: { var: "reply_1", equals: "no_reply" }
    });
    // The greeting keeps the owner's approved wording (vars substituted).
    expect(byId.get("s_greet")).toMatchObject({ to: "{{vars.lead_phone}}" });
    expect(String((byId.get("s_greet") as { body: string }).body)).toContain(
      "{{vars.lead_name}}"
    );
    // The industry placeholder became an extraction field.
    const extract = byId.get("s_extract") as { fields: Array<{ name: string }> };
    expect(extract.fields.map((f) => f.name)).toContain("lead_industry");
    // Nudges carry the Calendly link from the greeting.
    expect(String((byId.get("s_nudge_1") as { body: string }).body)).toContain(
      "calendly.com/james-kyp-ads/my-free-scale-plan"
    );
    expect(String((byId.get("s_nudge_2") as { body: string }).body)).toContain(
      "calendly.com/james-kyp-ads/my-free-scale-plan"
    );
    expect(String((byId.get("s_nudge_3") as { body: string }).body)).toContain(
      "calendly.com/james-kyp-ads/my-free-scale-plan"
    );
    // Personal-touch flag + Inactive tag, both gated on the final silence.
    expect(byId.get("s_flag_owner")).toMatchObject({
      when: { var: "reply_final", equals: "no_reply" }
    });
    expect(byId.get("s_mark_inactive")).toMatchObject({
      addTags: ["Inactive"],
      when: { var: "reply_final", equals: "no_reply" }
    });
    // Converted leads stop being nurtured (goal jump).
    expect(byId.get("s_goal")).toMatchObject({
      events: [{ kind: "replied" }, { kind: "appointment_booked" }]
    });
  });

  it("scales to 5 attempts and falls back to the industry preset greeting", () => {
    const answers: IntakeAnswers = {
      ...KYP_ANSWERS,
      greeting: "",
      handoff_after: "5_attempts"
    };
    const tpl = intakeFollowUpFlowTemplate(answers, KYP_META);
    const ids = tpl.definition.steps.map((s) => s.id);
    expect(ids).toContain("s_nudge_5");
    expect(tpl.definition.steps.length).toBeLessThanOrEqual(25);
    const greet = tpl.definition.steps.find((s) => s.id === "s_greet") as { body: string };
    // "other" industry preset wording.
    expect(greet.body).toContain("{{vars.lead_name}}");
    expect(greet.body).toContain("right person on our team");
    // Preset greeting has no link → nudges use their linkless variants.
    const nudge2 = tpl.definition.steps.find((s) => s.id === "s_nudge_2") as { body: string };
    expect(nudge2.body).toContain("Want me to help you get scheduled?");
    const nudge1 = tpl.definition.steps.find((s) => s.id === "s_nudge_1") as { body: string };
    expect(nudge1.body).not.toContain("grab a time");
    const nudge3 = tpl.definition.steps.find((s) => s.id === "s_nudge_3") as { body: string };
    expect(nudge3.body).toContain("still here whenever you're ready.");
  });
});

describe("vault sections", () => {
  it("soul section carries greeting, qualification, handoff topics, and tone notes", () => {
    const soul = renderIntakeSoulSection(KYP_ANSWERS, KYP_META);
    expect(soul).toContain(`"${KYP_GREETING}"`);
    // Blank qualification questions → the industry preset's.
    expect(soul).toContain("1. What can we help you with today?");
    expect(soul).toContain("- Quoting prices or discounts");
    expect(soul).toContain("Meta account access or passwords");
    expect(soul).toContain("- Any time the lead sounds frustrated.");
    expect(soul).toContain("### Tone & owner notes");
    expect(soul).toContain("casual, warm, and human");
  });

  it("soul section handles custom questions, empty handoffs, and no notes", () => {
    const answers: IntakeAnswers = {
      ...KYP_ANSWERS,
      qualification_questions: "Buy or sell?\nWhat area?\nTimeline?\nExtra ignored",
      never_handle: [],
      never_handle_other: "",
      notes: ""
    };
    const soul = renderIntakeSoulSection(answers, KYP_META);
    expect(soul).toContain("1. Buy or sell?");
    expect(soul).toContain("3. Timeline?");
    expect(soul).not.toContain("Extra ignored");
    expect(soul).toContain("(no specific topics selected)");
    expect(soul).not.toContain("### Tone & owner notes");
  });

  it("soul section falls back to the industry preset greeting and keeps unknown topics", () => {
    const answers = {
      ...KYP_ANSWERS,
      greeting: "",
      never_handle: ["pricing", "warranty_claims"],
      never_handle_other: ""
    } as IntakeAnswers;
    const soul = renderIntakeSoulSection(answers, KYP_META);
    expect(soul).toContain("right person on our team");
    // Unknown catalog values are kept verbatim, never dropped.
    expect(soul).toContain("- warranty_claims");
  });

  it("memory section carries scheduling rules, team, sources, cadence, compliance", () => {
    const memory = renderIntakeMemorySection(KYP_ANSWERS);
    expect(memory).toContain("- Business hours: 11am to 6pm");
    expect(memory).toContain("- Appointment length: 30 minutes");
    expect(memory).toContain("- Buffer: no buffer between appointments");
    expect(memory).toContain("- Earliest booking: book at least 2 hours ahead");
    expect(memory).toContain("- Booking window: up to 1 week out");
    expect(memory).toContain("- James - 514-518-8192");
    expect(memory).toContain("- Facebook / Instagram ads");
    expect(memory).toContain("- Website form");
    expect(memory).toContain("First nudge after 2 hours, second nudge the next day.");
    expect(memory).toContain("personal touch after 3 unanswered follow-ups");
    expect(memory).toContain("consent wording: in place");
  });

  it("memory section falls back gracefully on unknown values and empty team", () => {
    const answers = {
      ...KYP_ANSWERS,
      team: "  ",
      appointment_length: "90",
      appointment_buffer: "45",
      booking_notice: "whenever",
      booking_window: "1y",
      first_follow_up: "10m",
      second_follow_up: "1mo",
      lead_sources: ["other"],
      lead_sources_other: "",
      consent_confirmed: "not_yet"
    } as IntakeAnswers;
    const memory = renderIntakeMemorySection(answers);
    expect(memory).toContain("- Appointment length: 90");
    expect(memory).toContain("- Buffer: 45");
    expect(memory).toContain("- Earliest booking: whenever");
    expect(memory).toContain("- Booking window: 1y");
    expect(memory).toContain("- (not specified)");
    expect(memory).toContain("- Other");
    expect(memory).toContain("First nudge 10m, second nudge 1mo.");
    expect(memory).toContain("consent wording: needs help adding it");
  });
});

describe("buildIntakeApplyPlan", () => {
  it("composes marker blocks, parsed hours, and the flow from KYP's answers", () => {
    const plan = buildIntakeApplyPlan(KYP_ANSWERS, KYP_META);
    expect(plan.soulBlock.startsWith(WHITE_GLOVE_BLOCK_START)).toBe(true);
    expect(plan.soulBlock.endsWith(WHITE_GLOVE_BLOCK_END)).toBe(true);
    expect(plan.memoryBlock).toContain("### Scheduling rules");
    expect(plan.businessHours).toMatchObject({ mon: { open: "11:00", close: "18:00" } });
    expect(plan.flow.name).toBe(INTAKE_FOLLOW_UP_FLOW_NAME);
  });

  it("keeps unparseable hours out of the profile (memory keeps the raw text)", () => {
    const plan = buildIntakeApplyPlan(
      { ...KYP_ANSWERS, business_hours: "flexible, ping us anytime" },
      KYP_META
    );
    expect(plan.businessHours).toBeNull();
    expect(plan.memoryBlock).toContain("flexible, ping us anytime");
  });
});
