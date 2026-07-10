import { describe, expect, it } from "vitest";
import {
  INTAKE_QUESTIONS,
  INDUSTRY_OPTIONS,
  INDUSTRY_PRESETS,
  intakeAnswersSchema,
  renderWhiteGloveDoc,
  renderWhiteGloveDocSections,
  type IntakeAnswers
} from "@/lib/white-glove/template";

/** A fully-specified valid submission (every optional field present). */
function fullAnswers(): IntakeAnswers {
  return intakeAnswersSchema.parse({
    business_name: "Acme Home Services",
    industry: "home_services",
    industry_other: "",
    website: "https://acme.example",
    business_hours: "Mon–Fri 9am–5pm",
    team: "Jane Smith — 555-123-4567\nJohn Doe — 555-987-6543",
    lead_sources: ["facebook_instagram", "referrals", "other"],
    lead_sources_other: "Trade shows",
    tone: "friendly",
    greeting: "Hi {name}! Thanks for calling Acme.",
    qualification_questions: "What do you need fixed?\nHow soon?",
    appointment_length: "30",
    appointment_buffer: "15",
    booking_notice: "2h",
    booking_window: "30d",
    first_follow_up: "2h",
    second_follow_up: "next_day",
    handoff_after: "3_attempts",
    never_handle: ["pricing", "complaints", "other"],
    never_handle_other: "Warranty claims",
    consent_confirmed: "yes",
    notes: "Busy season is summer."
  });
}

describe("white-glove template questionnaire", () => {
  it("every question id maps to a schema key, and choice/multi questions carry options", () => {
    const schemaKeys = new Set(Object.keys(intakeAnswersSchema.shape));
    for (const q of INTAKE_QUESTIONS) {
      expect(schemaKeys.has(q.id)).toBe(true);
      if (q.type === "choice" || q.type === "multi") {
        expect(q.options && q.options.length >= 2).toBe(true);
      }
    }
  });

  it("every industry option has a preset with a greeting and at most 3 questions", () => {
    for (const opt of INDUSTRY_OPTIONS) {
      const preset = INDUSTRY_PRESETS[opt.value];
      expect(preset.greeting.length).toBeGreaterThan(0);
      expect(preset.qualificationQuestions.length).toBeGreaterThan(0);
      expect(preset.qualificationQuestions.length).toBeLessThanOrEqual(3);
    }
  });

  it("the schema applies defaults for omitted optional fields", () => {
    const minimal = intakeAnswersSchema.parse({
      business_name: "Solo Law",
      industry: "legal",
      business_hours: "By appointment",
      team: "Ana — 555-000-1111",
      lead_sources: ["website_form"],
      tone: "professional",
      appointment_length: "60",
      appointment_buffer: "none",
      booking_notice: "next_day",
      booking_window: "2w",
      first_follow_up: "next_morning",
      second_follow_up: "1w",
      handoff_after: "2_attempts",
      consent_confirmed: "not_yet"
    });
    expect(minimal.greeting).toBe("");
    expect(minimal.qualification_questions).toBe("");
    expect(minimal.never_handle).toEqual([]);
    expect(minimal.never_handle_other).toBe("");
    expect(minimal.notes).toBe("");
    expect(minimal.website).toBe("");
    expect(minimal.industry_other).toBe("");
    expect(minimal.lead_sources_other).toBe("");
  });

  it("the schema rejects unknown choice values and empty required fields", () => {
    const base = fullAnswers();
    expect(intakeAnswersSchema.safeParse({ ...base, industry: "nope" }).success).toBe(false);
    expect(intakeAnswersSchema.safeParse({ ...base, lead_sources: [] }).success).toBe(false);
    expect(intakeAnswersSchema.safeParse({ ...base, business_name: "  " }).success).toBe(false);
    expect(
      intakeAnswersSchema.safeParse({ ...base, never_handle: ["not_a_topic"] }).success
    ).toBe(false);
  });
});

describe("renderWhiteGloveDocSections", () => {
  it("merges every answer into the document", () => {
    const doc = renderWhiteGloveDocSections(fullAnswers());
    expect(doc.title).toBe("White-Glove Build & Installation — Acme Home Services");
    expect(doc.intro).toContain("single source of truth");
    const all = doc.sections.flatMap((s) => [s.heading, ...s.lines]).join("\n");
    // About / team / sources
    expect(all).toContain("Industry: Home services (HVAC, plumbing, roofing…)");
    expect(all).toContain("Website: https://acme.example");
    expect(all).toContain("Business hours: Mon–Fri 9am–5pm");
    expect(all).toContain("• Jane Smith — 555-123-4567");
    expect(all).toContain("• John Doe — 555-987-6543");
    expect(all).toContain("• Facebook / Instagram ads");
    expect(all).toContain("• Referrals");
    // Free-text "other" replaces the raw "other" token.
    expect(all).toContain("• Trade shows");
    // First message uses the CUSTOM greeting + questions.
    expect(all).toContain('"Hi {name}! Thanks for calling Acme."');
    expect(all).toContain("1. What do you need fixed?");
    expect(all).toContain("2. How soon?");
    // Appointments / follow-up labels resolved from values.
    expect(all).toContain("Appointment length: 30 minutes");
    expect(all).toContain("Buffer: 15 minutes between appointments");
    expect(all).toContain("Earliest booking: At least 2 hours ahead");
    expect(all).toContain("Booking window: Up to 30 days out");
    expect(all).toContain("First nudge: After 2 hours");
    expect(all).toContain("Second nudge: The next day");
    expect(all).toContain("Personal-touch flag: After 3 unanswered follow-ups");
    // Handoffs, compliance, notes.
    expect(all).toContain("• Quoting prices or discounts");
    expect(all).toContain("• Warranty claims");
    expect(all).toContain(
      "Lead-form text/call consent wording: Yes, our lead forms include text/call consent wording"
    );
    expect(all).toContain("Busy season is summer.");
    // Operator checklist + acceptance always present.
    expect(all).toContain("Installation checklist");
    expect(all).toContain("Go-live acceptance");
    expect(all).toContain("Customer signature");
  });

  it("falls back to the industry preset greeting/questions when left blank", () => {
    const answers = { ...fullAnswers(), greeting: "", qualification_questions: "" };
    const doc = renderWhiteGloveDocSections(answers);
    const all = doc.sections.flatMap((s) => s.lines).join("\n");
    expect(all).toContain(INDUSTRY_PRESETS.home_services.greeting);
    for (const q of INDUSTRY_PRESETS.home_services.qualificationQuestions) {
      expect(all).toContain(q);
    }
  });

  it("caps custom qualification questions at 3", () => {
    const answers = {
      ...fullAnswers(),
      qualification_questions: "Q1\nQ2\nQ3\nQ4\nQ5"
    };
    const all = renderWhiteGloveDocSections(answers)
      .sections.flatMap((s) => s.lines)
      .join("\n");
    expect(all).toContain("3. Q3");
    expect(all).not.toContain("Q4");
  });

  it("uses the free-text industry when 'other' is chosen (and the label when blank)", () => {
    const custom = { ...fullAnswers(), industry: "other", industry_other: "Landscaping design" };
    expect(
      renderWhiteGloveDocSections(custom).sections[0].lines.join("\n")
    ).toContain("Industry: Landscaping design");

    const blank = { ...fullAnswers(), industry: "other", industry_other: "" };
    expect(renderWhiteGloveDocSections(blank).sections[0].lines.join("\n")).toContain(
      "Industry: Other"
    );
  });

  it("renders placeholders for blank optional fields and empty handoff topics", () => {
    const answers = {
      ...fullAnswers(),
      website: "",
      notes: "",
      never_handle: [] as string[],
      never_handle_other: ""
    };
    const doc = renderWhiteGloveDocSections(answers);
    const all = doc.sections.flatMap((s) => s.lines).join("\n");
    expect(all).toContain("Website: —");
    expect(all).toContain("• (none selected)");
    expect(doc.sections.find((s) => s.heading === "9. Notes")?.lines).toEqual(["—"]);
  });

  it("survives an unknown stored choice value by printing the raw value", () => {
    // Defensive path: a hand-edited row with a value no longer in the catalog
    // still renders (labelOf falls back to the raw value).
    const answers = { ...fullAnswers(), tone: "sassy" as IntakeAnswers["tone"] };
    const all = renderWhiteGloveDocSections(answers)
      .sections.flatMap((s) => s.lines)
      .join("\n");
    expect(all).toContain("Tone: sassy");
  });
});

describe("renderWhiteGloveDoc (markdown)", () => {
  it("emits the title, intro, and every section as markdown", () => {
    const md = renderWhiteGloveDoc(fullAnswers());
    expect(md).toContain("# White-Glove Build & Installation — Acme Home Services");
    const doc = renderWhiteGloveDocSections(fullAnswers());
    for (const section of doc.sections) {
      expect(md).toContain(`## ${section.heading}`);
    }
    expect(md).toContain(doc.intro);
  });
});
