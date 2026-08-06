import { describe, expect, it } from "vitest";
import {
  VERBATIM_ALERT_THRESHOLD,
  normalizeSpokenText,
  scoreVerbatim,
  verbatimNeedsReview
} from "../supabase/functions/_shared/voice_verbatim";

/**
 * A voicemail is written copy an owner approved, played to someone who cannot
 * interrupt or correct it. These tests pin the behaviors that decide whether
 * the score means anything: that ordinary transcription noise does not look
 * like drift, and that an invented sentence does.
 */

/** Amy Laidlaw's Clever voicemail, close to the shipped length. */
const SCRIPT =
  "Hi Sarah, this is the Amy Laidlaw Team with HomeSmart, calling about your " +
  "request through Clever and selling your home. We would love to help. Give " +
  "us a call back at 602 695 1142. Looking forward to hearing back from you soon.";

describe("normalizeSpokenText", () => {
  it("reduces case, punctuation, and spacing to plain words", () => {
    expect(normalizeSpokenText("  Hi,   Sarah!  This is Amy. ")).toEqual([
      "hi",
      "sarah",
      "this",
      "is",
      "amy"
    ]);
  });

  // A transcriber may write "I'll" or "Ill"; neither is the assistant saying
  // something different.
  it("folds apostrophes rather than splitting the word", () => {
    expect(normalizeSpokenText("I'll")).toEqual(["ill"]);
    expect(normalizeSpokenText("I’ll")).toEqual(["ill"]);
    expect(normalizeSpokenText("Ill")).toEqual(["ill"]);
  });

  // Dropping a digit from a callback number is exactly the drift worth
  // catching, so digits stay as their own comparable words.
  it("keeps digits as words", () => {
    expect(normalizeSpokenText("call 602 695 1142")).toEqual([
      "call",
      "602",
      "695",
      "1142"
    ]);
  });

  it("returns nothing for empty or punctuation-only text", () => {
    expect(normalizeSpokenText("")).toEqual([]);
    expect(normalizeSpokenText("   ")).toEqual([]);
    expect(normalizeSpokenText("... !! ")).toEqual([]);
  });
});

describe("scoreVerbatim", () => {
  it("scores an exact read as 1", () => {
    const r = scoreVerbatim(SCRIPT, SCRIPT);
    expect(r.score).toBe(1);
    expect(r.edits).toBe(0);
    expect(r.scriptWords).toBeGreaterThan(40);
  });

  // The read a real transcript produces: same words, different casing and
  // punctuation. That is a perfect read, not drift.
  it("ignores casing and punctuation differences entirely", () => {
    const spoken = SCRIPT.toUpperCase().replace(/[.,]/g, "");
    expect(scoreVerbatim(spoken, SCRIPT).score).toBe(1);
  });

  it("charges one edit for one substituted word", () => {
    const spoken = SCRIPT.replace("would love to help", "would like to help");
    const r = scoreVerbatim(spoken, SCRIPT);
    expect(r.edits).toBe(1);
    // One word out of ~55 is a near-perfect read and must stay well clear of
    // the alert threshold, or every call would page someone.
    expect(r.score).toBeGreaterThan(0.95);
    expect(verbatimNeedsReview(r.score)).toBe(false);
  });

  // Additions are the drift most worth catching: an invented sentence in a
  // voicemail is a commitment nobody approved. A score that only measured
  // omission would call this a perfect read.
  it("penalizes an improvised addition, not just omission", () => {
    const spoken = `${SCRIPT} We can also guarantee we will sell your home in thirty days.`;
    const r = scoreVerbatim(spoken, SCRIPT);
    expect(r.edits).toBeGreaterThan(8);
    expect(verbatimNeedsReview(r.score)).toBe(true);
  });

  it("penalizes a dropped half of the script", () => {
    const spoken = SCRIPT.slice(0, Math.floor(SCRIPT.length / 2));
    expect(verbatimNeedsReview(scoreVerbatim(spoken, SCRIPT).score)).toBe(true);
  });

  // A wrong callback number is a functional failure, not a stylistic one.
  it("notices a mangled phone number", () => {
    const spoken = SCRIPT.replace("602 695 1142", "602 695 1143");
    const r = scoreVerbatim(spoken, SCRIPT);
    expect(r.edits).toBe(1);
  });

  it("scores unrelated speech near zero", () => {
    const r = scoreVerbatim("Hello you have reached the Johnson residence", SCRIPT);
    expect(r.score).toBeLessThan(0.2);
    expect(verbatimNeedsReview(r.score)).toBe(true);
  });

  it("scores silence as zero against a real script", () => {
    const r = scoreVerbatim("", SCRIPT);
    expect(r.score).toBe(0);
    expect(r.edits).toBe(r.scriptWords);
  });

  // "No script configured" is a different question from "the read was bad",
  // and callers should branch on it before scoring.
  it("treats an empty script as nothing to deviate from", () => {
    const r = scoreVerbatim("anything at all", "");
    expect(r.score).toBe(1);
    expect(r.scriptWords).toBe(0);
    expect(r.edits).toBe(3);
  });

  it("scores two empties as a match", () => {
    expect(scoreVerbatim("", "").score).toBe(1);
  });

  it("stays within 0 and 1 even when the read is far longer than the script", () => {
    const r = scoreVerbatim(`${SCRIPT} ${SCRIPT} ${SCRIPT}`, SCRIPT);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it("is symmetric in distance but normalized by the longer text", () => {
    const a = scoreVerbatim("one two three", "one two three four");
    const b = scoreVerbatim("one two three four", "one two three");
    expect(a.edits).toBe(b.edits);
    expect(a.score).toBe(b.score);
  });

  it("rounds to four decimals so stored values stay comparable", () => {
    const r = scoreVerbatim("one two three", "one two four");
    expect(Number.isInteger(r.score * 10_000)).toBe(true);
  });
});

describe("verbatimNeedsReview", () => {
  it("brackets the threshold", () => {
    expect(verbatimNeedsReview(VERBATIM_ALERT_THRESHOLD)).toBe(false);
    expect(verbatimNeedsReview(VERBATIM_ALERT_THRESHOLD - 0.0001)).toBe(true);
    expect(verbatimNeedsReview(1)).toBe(false);
    expect(verbatimNeedsReview(0)).toBe(true);
  });
});
