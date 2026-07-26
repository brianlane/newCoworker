/**
 * The intake question vocabulary: lenient about what the OWNER stored (junk
 * is dropped, never fatal to the public page), strict about what the
 * VISITOR submitted (required answered, choices from the offered options),
 * and readable when rendered for a person.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_INTAKE_QUESTIONS,
  MAX_TEXT_ANSWER_LENGTH,
  formatIntakeAnswers,
  parseIntakeQuestions,
  validateIntakeAnswers,
  type BookingIntakeQuestion
} from "@/lib/booking-page/intake";

const PROJECT: BookingIntakeQuestion = {
  id: "project",
  label: "What kind of project?",
  type: "choice",
  options: ["Kitchen", "Bathroom"],
  required: true
};
const DETAILS: BookingIntakeQuestion = {
  id: "details",
  label: "Anything else?",
  type: "textarea",
  required: false
};

describe("parseIntakeQuestions", () => {
  it("normalizes a stored list and preserves order", () => {
    const parsed = parseIntakeQuestions([
      { id: "project", label: " What kind of project? ", type: "choice", options: ["Kitchen", " Bathroom "], required: true, help: " Pick the closest. " },
      { id: "details", label: "Anything else?", type: "textarea", required: false }
    ]);
    expect(parsed).toEqual([
      {
        id: "project",
        label: "What kind of project?",
        help: "Pick the closest.",
        type: "choice",
        options: ["Kitchen", "Bathroom"],
        required: true
      },
      { id: "details", label: "Anything else?", type: "textarea", required: false }
    ]);
  });

  it("drops junk instead of failing: settings rot must never take the page down", () => {
    expect(
      parseIntakeQuestions([
        null,
        "nonsense",
        { id: "BAD ID!", label: "x", type: "text", required: false },
        { id: "no-label", label: "   ", type: "text", required: false },
        { id: "long", label: "x".repeat(200), type: "text", required: false },
        { id: "weird", label: "x", type: "rating", required: false },
        // A choice with fewer than two usable options is not a question.
        { id: "onechoice", label: "x", type: "choice", options: ["Only"], required: true },
        { id: "emptyopts", label: "x", type: "multi", options: [42, "  "], required: false },
        { id: "ok", label: "Keeps the good one", type: "text", required: false },
        // Duplicate ids: first wins.
        { id: "ok", label: "Impostor", type: "text", required: false }
      ]).map((q) => q.id)
    ).toEqual(["ok"]);

    expect(parseIntakeQuestions(null)).toEqual([]);
    expect(parseIntakeQuestions({ not: "an array" })).toEqual([]);
  });

  it("caps the list and each option set", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`,
      label: `Q${i}`,
      type: "text",
      required: false
    }));
    expect(parseIntakeQuestions(many)).toHaveLength(MAX_INTAKE_QUESTIONS);

    const opts = parseIntakeQuestions([
      {
        id: "big",
        label: "x",
        type: "multi",
        options: Array.from({ length: 12 }, (_, i) => `opt${i}`),
        required: false
      }
    ]);
    expect(opts[0].options).toHaveLength(8);
  });
});

describe("validateIntakeAnswers", () => {
  it("accepts answers, trims text, and caps its length", () => {
    const out = validateIntakeAnswers([PROJECT, DETAILS], {
      project: "Kitchen",
      details: `  ${"x".repeat(600)}  `
    });
    expect(out.ok && out.answers.project).toBe("Kitchen");
    expect(out.ok && (out.answers.details as string).length).toBe(MAX_TEXT_ANSWER_LENGTH);
  });

  it("names the questions that are missing", () => {
    const out = validateIntakeAnswers([PROJECT, DETAILS], {});
    expect(out).toEqual({ ok: false, missing: ["project"] });
    // Optional unanswered is fine.
    const ok = validateIntakeAnswers([DETAILS], {});
    expect(ok).toEqual({ ok: true, answers: {} });
  });

  it("refuses an invented choice, but discards answers to questions that no longer exist", () => {
    // Not one of the offered options reads as unanswered (the options may
    // have changed under an open form).
    expect(validateIntakeAnswers([PROJECT], { project: "Spaceship" })).toEqual({
      ok: false,
      missing: ["project"]
    });
    // The owner deleted a question while the form sat open: silently drop.
    const out = validateIntakeAnswers([DETAILS], { ghost: "boo", details: "hi" });
    expect(out.ok && out.answers).toEqual({ details: "hi" });

    // An invented choice on an OPTIONAL question is dropped, not fatal.
    const relaxed = validateIntakeAnswers([{ ...PROJECT, required: false }], {
      project: "Spaceship"
    });
    expect(relaxed).toEqual({ ok: true, answers: {} });
  });

  it("multi keeps only offered options and treats an empty pick as unanswered", () => {
    const q: BookingIntakeQuestion = {
      id: "rooms",
      label: "Which rooms?",
      type: "multi",
      options: ["Kitchen", "Bathroom"],
      required: true
    };
    const out = validateIntakeAnswers([q], { rooms: ["Kitchen", "Spaceship", 42] });
    expect(out.ok && out.answers.rooms).toEqual(["Kitchen"]);

    expect(validateIntakeAnswers([q], { rooms: ["Spaceship"] })).toEqual({
      ok: false,
      missing: ["rooms"]
    });
    expect(validateIntakeAnswers([q], { rooms: "not-an-array" })).toEqual({
      ok: false,
      missing: ["rooms"]
    });

    const optional = validateIntakeAnswers([{ ...q, required: false }], { rooms: [] });
    expect(optional.ok && optional.answers).toEqual({});
  });

  it("covers the defensive corners: missing fields, absent option lists, odd values", () => {
    // Stored entries with non-string id/label and no options key at all.
    expect(
      parseIntakeQuestions([
        { id: 42, label: "x", type: "text", required: false },
        { id: "x", label: 42, type: "text", required: false },
        { id: "c", label: "x", type: "choice", required: false }
      ])
    ).toEqual([]);

    // Hand-built questions without an options list (the parser never emits
    // these, but validate must not crash on them).
    const bareChoice: BookingIntakeQuestion = {
      id: "c",
      label: "C",
      type: "choice",
      required: true
    };
    const bareMulti: BookingIntakeQuestion = {
      id: "m",
      label: "M",
      type: "multi",
      required: true
    };
    expect(validateIntakeAnswers([bareChoice], { c: "anything" })).toEqual({
      ok: false,
      missing: ["c"]
    });
    expect(validateIntakeAnswers([bareMulti], { m: ["anything"] })).toEqual({
      ok: false,
      missing: ["m"]
    });

    // A non-string value for a text question reads as unanswered.
    expect(validateIntakeAnswers([{ ...DETAILS, required: true }], { details: 42 })).toEqual({
      ok: false,
      missing: ["details"]
    });
  });

  it("tolerates a non-object submission", () => {
    expect(validateIntakeAnswers([DETAILS], null)).toEqual({ ok: true, answers: {} });
    expect(validateIntakeAnswers([PROJECT], "junk")).toEqual({
      ok: false,
      missing: ["project"]
    });
  });
});

describe("formatIntakeAnswers", () => {
  it("renders answered questions as label: answer lines, in question order", () => {
    expect(
      formatIntakeAnswers([PROJECT, DETAILS], {
        details: "Back unit only",
        project: "Kitchen"
      })
    ).toEqual(["What kind of project?: Kitchen", "Anything else?: Back unit only"]);
  });

  it("omits unanswered questions rather than rendering them empty", () => {
    expect(formatIntakeAnswers([PROJECT, DETAILS], { project: "Kitchen" })).toEqual([
      "What kind of project?: Kitchen"
    ]);
    const multi: BookingIntakeQuestion = {
      id: "rooms",
      label: "Rooms",
      type: "multi",
      options: ["A", "B"],
      required: false
    };
    expect(formatIntakeAnswers([multi], { rooms: ["A", "B"] })).toEqual(["Rooms: A, B"]);
    expect(formatIntakeAnswers([multi], { rooms: [] })).toEqual([]);
  });
});
