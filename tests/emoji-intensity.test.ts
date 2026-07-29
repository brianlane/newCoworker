import { describe, expect, it } from "vitest";
import {
  EMOJI_INTENSITY_DEFAULT,
  EMOJI_INTENSITY_UI_TITLES,
  EMOJI_INTENSITY_WORKER_INSTRUCTIONS,
  normalizeEmojiIntensity,
  SMS_EMOJI_INTENSITY_LINE
} from "../src/lib/emoji-intensity";
import * as edge from "../supabase/functions/_shared/emoji_intensity";
import en from "../messages/en.json";
import es from "../messages/es.json";

/**
 * Pins the Next.js emoji-intensity module and the Deno-edge mirror to
 * identical exports. They're duplicated by necessity (Deno can't import
 * from src/), but they MUST stay in lockstep.
 */
describe("emoji intensity parity (Next.js ↔ edge)", () => {
  it("constants and helpers match", () => {
    expect(edge.EMOJI_INTENSITY_MIN).toBe(0);
    expect(edge.EMOJI_INTENSITY_MAX).toBe(5);
    expect(edge.EMOJI_INTENSITY_DEFAULT).toBe(EMOJI_INTENSITY_DEFAULT);
    expect([...edge.EMOJI_INTENSITY_UI_TITLES]).toEqual([...EMOJI_INTENSITY_UI_TITLES]);
    expect([...edge.EMOJI_INTENSITY_WORKER_INSTRUCTIONS]).toEqual([
      ...EMOJI_INTENSITY_WORKER_INSTRUCTIONS
    ]);
    for (const n of [
      0, 1, 2, 3, 4, 5, null, undefined, "3", 99, -1, 2.5, "", "  ", "nope", "7"
    ] as const) {
      expect(edge.normalizeEmojiIntensity(n), String(n)).toBe(normalizeEmojiIntensity(n));
      expect(edge.SMS_EMOJI_INTENSITY_LINE(n), String(n)).toBe(SMS_EMOJI_INTENSITY_LINE(n));
    }
  });
});

describe("SMS_EMOJI_INTENSITY_LINE", () => {
  it("embeds worker instructions for 0, 2, and 5", () => {
    expect(SMS_EMOJI_INTENSITY_LINE(0)).toContain("No emoji.");
    expect(SMS_EMOJI_INTENSITY_LINE(0)).toContain("0/5");
    expect(SMS_EMOJI_INTENSITY_LINE(2)).toContain(
      "maybe once in an SMS thread conversation for the day"
    );
    expect(SMS_EMOJI_INTENSITY_LINE(5)).toContain("row of them at the bottom");
    expect(SMS_EMOJI_INTENSITY_LINE(5)).toContain("Multiple");
  });

  it("falls back to Light for missing / invalid values", () => {
    expect(normalizeEmojiIntensity(undefined)).toBe(2);
    expect(normalizeEmojiIntensity(null)).toBe(2);
    expect(normalizeEmojiIntensity(9)).toBe(2);
    expect(normalizeEmojiIntensity(2.5)).toBe(2);
    expect(normalizeEmojiIntensity("")).toBe(2);
    expect(normalizeEmojiIntensity("  ")).toBe(2);
    expect(normalizeEmojiIntensity("nope")).toBe(2);
    expect(normalizeEmojiIntensity("7")).toBe(2);
    expect(SMS_EMOJI_INTENSITY_LINE(undefined)).toBe(SMS_EMOJI_INTENSITY_LINE(2));
  });
});

describe("emoji intensity i18n titles", () => {
  it("en catalog mirrors English UI titles; es has all six keys", () => {
    const pages = en.dashboard.pages as Record<string, string>;
    const pagesEs = es.dashboard.pages as Record<string, string>;
    for (let i = 0; i <= 5; i++) {
      const key = `emojiIntensity${i}`;
      expect(pages[key]).toBe(EMOJI_INTENSITY_UI_TITLES[i]);
      expect(pagesEs[key]?.length).toBeGreaterThan(0);
    }
    expect(pages.emojiIntensityLabel).toBeTruthy();
    expect(pagesEs.emojiIntensityLabel).toBeTruthy();
  });
});
