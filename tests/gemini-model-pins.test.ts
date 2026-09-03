import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GEMINI_PRICES_PER_1M as APP_PRICES
} from "@/lib/billing/ai-spend-meter";
import {
  GEMINI_MODEL_PINS,
  compareGeminiVersions,
  isUnstableGeminiId,
  parseGeminiModelId,
  pinById,
  pinsForFamily,
  stripGeminiModelsPrefix
} from "@/lib/gemini-model-pins";
import { GEMINI_PRICES_PER_1M as EDGE_PRICES } from "../supabase/functions/_shared/chat_spend_cap";

const ROOT = join(__dirname, "..");

describe("stripGeminiModelsPrefix", () => {
  it("strips a models/ prefix and trims", () => {
    expect(stripGeminiModelsPrefix(" models/gemini-3.7-flash ")).toBe("gemini-3.7-flash");
    expect(stripGeminiModelsPrefix("gemini-3.7-flash")).toBe("gemini-3.7-flash");
  });
});

describe("isUnstableGeminiId", () => {
  it("flags preview, exp, latest, cyber, tts, and robotics ids", () => {
    expect(isUnstableGeminiId("gemini-3.5-live-translate-preview")).toBe(true);
    expect(isUnstableGeminiId("gemini-exp-1206")).toBe(true);
    expect(isUnstableGeminiId("gemini-3-experimental")).toBe(true);
    expect(isUnstableGeminiId("gemini-3.7-flash-latest")).toBe(true);
    expect(isUnstableGeminiId("gemini-3-latest-flash")).toBe(true);
    expect(isUnstableGeminiId("gemini-3.8-flash-cyber")).toBe(true);
    expect(isUnstableGeminiId("gemini-2.5-flash-tts")).toBe(true);
    expect(isUnstableGeminiId("gemini-robotics-er-1.5-preview")).toBe(true);
  });

  it("lets a GA flash id through", () => {
    expect(isUnstableGeminiId("gemini-3.7-flash")).toBe(false);
    expect(isUnstableGeminiId("gemini-3.5-flash-lite")).toBe(false);
  });
});

describe("parseGeminiModelId", () => {
  it("returns null for empty, non-gemini, or unversioned ids", () => {
    expect(parseGeminiModelId("")).toBeNull();
    expect(parseGeminiModelId("   ")).toBeNull();
    expect(parseGeminiModelId("models/")).toBeNull();
    expect(parseGeminiModelId("gpt-4")).toBeNull();
    expect(parseGeminiModelId("gemini-flash")).toBeNull();
  });

  it("classifies families and versions", () => {
    expect(parseGeminiModelId("models/gemini-3.7-flash")).toEqual({
      id: "gemini-3.7-flash",
      family: "flagship",
      version: [3, 7],
      unstable: false
    });
    expect(parseGeminiModelId("gemini-3-flash")).toMatchObject({
      family: "flagship",
      version: [3, 0]
    });
    expect(parseGeminiModelId("gemini-3.5-flash-lite")).toMatchObject({
      family: "mid",
      version: [3, 5]
    });
    expect(parseGeminiModelId("gemini-3.1-flash-lite-image")).toMatchObject({
      family: "image",
      version: [3, 1]
    });
    expect(parseGeminiModelId("gemini-2.5-flash-native-audio-preview-09-2025")).toMatchObject({
      family: "live",
      unstable: true
    });
    expect(parseGeminiModelId("gemini-3.5-live-translate-preview")).toMatchObject({
      family: "live",
      unstable: true
    });
    expect(parseGeminiModelId("gemini-3.1-pro")).toMatchObject({
      family: "pro",
      version: [3, 1]
    });
    expect(parseGeminiModelId("gemini-3-embedding")).toMatchObject({
      family: "other",
      version: [3, 0]
    });
  });
});

describe("compareGeminiVersions", () => {
  it("orders by major then minor", () => {
    expect(compareGeminiVersions([3, 8], [3, 7])).toBeGreaterThan(0);
    expect(compareGeminiVersions([3, 7], [3, 8])).toBeLessThan(0);
    expect(compareGeminiVersions([2, 5], [3, 0])).toBeLessThan(0);
    expect(compareGeminiVersions([3, 7], [3, 7])).toBe(0);
  });
});

describe("GEMINI_MODEL_PINS", () => {
  it("has unique ids", () => {
    const ids = GEMINI_MODEL_PINS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pinById and pinsForFamily find the rows", () => {
    expect(pinById("sms-chat")?.defaultModel).toBe("gemini-3.5-flash-lite");
    expect(pinById("missing")).toBeUndefined();
    expect(pinsForFamily("flagship").every((p) => p.family === "flagship")).toBe(true);
    expect(pinsForFamily("flagship").length).toBeGreaterThan(0);
  });

  it("every source file still contains the pin's mustContain string", () => {
    const missing: string[] = [];
    for (const pin of GEMINI_MODEL_PINS) {
      for (const source of pin.sources) {
        const text = readFileSync(join(ROOT, source.file), "utf8");
        if (!text.includes(source.mustContain)) {
          missing.push(`${pin.id}: ${source.file} missing ${JSON.stringify(source.mustContain)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the app and edge price-table keys in lockstep", () => {
    expect(Object.keys(EDGE_PRICES).sort()).toEqual(Object.keys(APP_PRICES).sort());
  });
});
