/**
 * Contact notes domain rules (src/lib/notes/core.ts): body validation,
 * author-label snapshots, and the relative-time buckets the panel renders.
 */
import { describe, expect, it } from "vitest";
import {
  NOTE_AUTHOR_LABEL_MAX,
  NOTE_BODY_MAX,
  noteAuthorLabel,
  noteRelativeTime,
  validateNoteBody
} from "@/lib/notes/core";

describe("validateNoteBody", () => {
  it("trims and accepts a normal body", () => {
    expect(validateNoteBody("  Prefers evening calls  ")).toEqual({
      ok: true,
      body: "Prefers evening calls"
    });
  });

  it("accepts a body exactly at the cap", () => {
    const body = "x".repeat(NOTE_BODY_MAX);
    expect(validateNoteBody(body)).toEqual({ ok: true, body });
  });

  it("refuses an empty or whitespace-only body", () => {
    expect(validateNoteBody("")).toEqual({ ok: false, error: "Note cannot be empty." });
    expect(validateNoteBody("   \n\t ")).toEqual({ ok: false, error: "Note cannot be empty." });
  });

  it("refuses a body over the cap, naming both lengths", () => {
    const result = validateNoteBody("x".repeat(NOTE_BODY_MAX + 1));
    expect(result).toEqual({
      ok: false,
      error: `Note is too long (${NOTE_BODY_MAX + 1} chars; max ${NOTE_BODY_MAX}).`
    });
  });
});

describe("noteAuthorLabel", () => {
  it("prefers the roster member name, trimmed", () => {
    expect(noteAuthorLabel("  Sarah Ortiz  ", "sarah@example.com")).toBe("Sarah Ortiz");
  });

  it("falls back to the email when the name is missing or blank", () => {
    expect(noteAuthorLabel(null, "sarah@example.com")).toBe("sarah@example.com");
    expect(noteAuthorLabel("   ", " sarah@example.com ")).toBe("sarah@example.com");
  });

  it("falls back to a generic label when both are absent", () => {
    expect(noteAuthorLabel(null, null)).toBe("Teammate");
    expect(noteAuthorLabel(undefined, "  ")).toBe("Teammate");
  });

  it("truncates oversized names and emails to the label cap", () => {
    expect(noteAuthorLabel("n".repeat(NOTE_AUTHOR_LABEL_MAX + 10), null)).toBe(
      "n".repeat(NOTE_AUTHOR_LABEL_MAX)
    );
    expect(noteAuthorLabel(null, "e".repeat(NOTE_AUTHOR_LABEL_MAX + 10))).toBe(
      "e".repeat(NOTE_AUTHOR_LABEL_MAX)
    );
  });
});

describe("noteRelativeTime", () => {
  const now = Date.parse("2026-02-10T12:00:00Z");
  const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();

  it("buckets sub-minute ages as justNow", () => {
    expect(noteRelativeTime(at(0), now)).toEqual({ kind: "justNow" });
    expect(noteRelativeTime(at(59_000), now)).toEqual({ kind: "justNow" });
  });

  it("buckets minutes up to an hour", () => {
    expect(noteRelativeTime(at(60_000), now)).toEqual({ kind: "minutes", count: 1 });
    expect(noteRelativeTime(at(59 * 60_000), now)).toEqual({ kind: "minutes", count: 59 });
  });

  it("buckets hours up to a day", () => {
    expect(noteRelativeTime(at(60 * 60_000), now)).toEqual({ kind: "hours", count: 1 });
    expect(noteRelativeTime(at(23 * 60 * 60_000), now)).toEqual({ kind: "hours", count: 23 });
  });

  it("buckets days up to thirty", () => {
    expect(noteRelativeTime(at(24 * 60 * 60_000), now)).toEqual({ kind: "days", count: 1 });
    expect(noteRelativeTime(at(29 * 24 * 60 * 60_000), now)).toEqual({ kind: "days", count: 29 });
  });

  it("hands 30+ day ages to the absolute date", () => {
    expect(noteRelativeTime(at(30 * 24 * 60 * 60_000), now)).toEqual({ kind: "date" });
  });

  it("hands unparseable and future timestamps to the absolute date", () => {
    expect(noteRelativeTime("not-a-date", now)).toEqual({ kind: "date" });
    expect(noteRelativeTime(at(-60_000), now)).toEqual({ kind: "date" });
  });
});
