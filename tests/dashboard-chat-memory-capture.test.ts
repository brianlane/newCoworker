/**
 * Inline owner-rule memory capture
 * (src/lib/dashboard-chat/memory-capture.ts): extraction parsing parity
 * with the worker twin, prompt composition, payload fitting, and the full
 * silent-capture orchestration with injected deps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import type { GeminiGenerateTextParams } from "@/lib/gemini-generate-content";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { BULLETS_MAX_CHARS } from "@/lib/dashboard-chat/memory-append";
import {
  captureOwnerRuleInline,
  composeExtractionInput,
  extractExistingBullets,
  fitBulletsToPayload,
  normalizeBullets,
  parseMemoryExtraction
} from "@/lib/dashboard-chat/memory-capture";

const BIZ = "11111111-1111-4111-8111-111111111111";
const meter = vi.mocked(meterGeminiSpendForBusiness);

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "MEMORY_CAPTURE_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.MEMORY_CAPTURE_MODEL;
  meter.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("normalizeBullets / parseMemoryExtraction", () => {
  it("cleans markers/whitespace, dedupes case-insensitively, caps count + length", () => {
    expect(normalizeBullets(["- One  rule", "one rule", "• Two", 3, "", "x".repeat(500)])).toEqual([
      "One rule",
      "Two",
      "x".repeat(280)
    ]);
    expect(normalizeBullets("not an array")).toEqual([]);
    expect(normalizeBullets(Array.from({ length: 15 }, (_, i) => `r${i}`))).toHaveLength(10);
  });

  it("parses a JSON string reply and degrades on malformed input", () => {
    expect(parseMemoryExtraction('{"save": true, "bullets": ["Rule"]}')).toEqual({
      save: true,
      bullets: ["Rule"]
    });
    expect(parseMemoryExtraction("not json")).toEqual({ save: false, bullets: [] });
    expect(parseMemoryExtraction(null)).toEqual({ save: false, bullets: [] });
    expect(parseMemoryExtraction([1])).toEqual({ save: false, bullets: [] });
    // save:true with no usable bullets is a no-op.
    expect(parseMemoryExtraction({ save: true, bullets: [] })).toEqual({
      save: false,
      bullets: []
    });
    expect(parseMemoryExtraction({ save: false, bullets: ["x"] })).toEqual({
      save: false,
      bullets: []
    });
  });
});

describe("extractExistingBullets / composeExtractionInput", () => {
  it("collects markdown list lines only (and tolerates non-strings)", () => {
    expect(extractExistingBullets("# H\n- one\ntext\n* two\n•  three ")).toEqual([
      "one",
      "two",
      "three"
    ]);
    expect(extractExistingBullets(null)).toEqual([]);
  });

  it("includes the reply and existing bullets only when present", () => {
    const bare = composeExtractionInput("msg");
    expect(bare).toBe("OWNER MESSAGE:\nmsg");
    const full = composeExtractionInput("msg", {
      assistantReply: "reply",
      existingBullets: ["a", " ", "b"]
    });
    expect(full).toContain("ASSISTANT REPLY");
    expect(full).toContain("- a\n- b");
  });
});

describe("fitBulletsToPayload", () => {
  it("keeps the longest fitting prefix and truncates a single oversize bullet", () => {
    expect(fitBulletsToPayload(["aa", "bb", "cc"], 5)).toEqual(["aa", "bb"]);
    expect(fitBulletsToPayload(["x".repeat(50)], 10)).toEqual(["x".repeat(10)]);
    expect(fitBulletsToPayload([1 as never, "ok"], BULLETS_MAX_CHARS)).toEqual(["ok"]);
  });
});

describe("captureOwnerRuleInline", () => {
  function makeDeps(overrides: Partial<Parameters<typeof captureOwnerRuleInline>[1]> = {}) {
    const base = {
      generate: vi.fn(async (_p: GeminiGenerateTextParams) => ({
        text: '{"save": true, "bullets": ["Closed Sundays"]}',
        usage: { promptTokens: 10, outputTokens: 5 }
      })),
      isToolEnabled: vi.fn(async () => true),
      fetchConfig: vi.fn(async () => ({ memory_md: "- Existing rule" }) as never),
      append: vi.fn(async () => ({
        appended: true,
        savedBullets: ["Closed Sundays"],
        skippedDuplicates: 0,
        memoryChars: 100,
        truncated: false
      }))
    };
    // Object.assign keeps the base's Mock types visible (an object-spread of
    // the Partial would widen them to the plain function unions).
    return Object.assign(base, overrides as Record<string, never>);
  }

  it("captures and persists a durable rule (metered, existing bullets in the prompt)", async () => {
    const deps = makeDeps();
    const res = await captureOwnerRuleInline(
      { businessId: BIZ, ownerMessage: "We are closed Sundays", assistantReply: "Got it." },
      deps
    );
    expect(res.saved).toEqual(["Closed Sundays"]);
    expect(deps.append).toHaveBeenCalledWith(BIZ, "Closed Sundays");
    const call = deps.generate.mock.calls[0][0];
    expect(call.userText).toContain("We are closed Sundays");
    expect(call.userText).toContain("- Existing rule");
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ surface: "memory_capture" }));
  });

  it("no-ops on an empty message, a missing key, or a disabled toggle", async () => {
    const deps = makeDeps();
    expect(
      (await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "  " }, deps)).saved
    ).toEqual([]);
    delete process.env.GOOGLE_API_KEY;
    expect(
      (await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, deps)).saved
    ).toEqual([]);
    process.env.GOOGLE_API_KEY = "k";
    const disabled = makeDeps({ isToolEnabled: vi.fn(async () => false) });
    expect(
      (await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, disabled)).saved
    ).toEqual([]);
    expect(disabled.generate).not.toHaveBeenCalled();
  });

  it("accepts GEMINI_API_KEY + a configured model and tolerates a config read failure", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "alt";
    process.env.MEMORY_CAPTURE_MODEL = "gemini-custom";
    const deps = makeDeps({
      fetchConfig: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    const res = await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, deps);
    expect(res.saved).toEqual(["Closed Sundays"]);
    expect(deps.generate.mock.calls[0][0]).toMatchObject({ apiKey: "alt", model: "gemini-custom" });
  });

  it("meters a billed-but-empty extraction and drops the capture", async () => {
    const deps = makeDeps({
      generate: vi.fn(async () => {
        throw new GeminiEmptyError({ promptTokens: 50, outputTokens: 10 });
      })
    });
    const res = await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, deps);
    expect(res.saved).toEqual([]);
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "memory_capture", outputChars: 0 })
    );
  });

  it("drops the capture on a thrown extraction (non-billed), tolerating non-Error throws", async () => {
    const deps = makeDeps({
      generate: vi.fn(async () => {
        throw new Error("gemini_http_500");
      })
    });
    const res = await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, deps);
    expect(res.saved).toEqual([]);
    expect(meter).not.toHaveBeenCalled();
    expect(deps.append).not.toHaveBeenCalled();

    const stringThrow = makeDeps({
      generate: vi.fn(async () => {
        throw "string failure";
      })
    });
    expect(
      (await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, stringThrow)).saved
    ).toEqual([]);
  });

  it("never throws — a non-Error toggle failure resolves to a no-op", async () => {
    const deps = makeDeps({
      isToolEnabled: vi.fn(async () => {
        throw "settings read blew up";
      })
    });
    const res = await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, deps);
    expect(res.saved).toEqual([]);
  });

  it("no-ops when the model says save=false and when nothing fits", async () => {
    const noSave = makeDeps({
      generate: vi.fn(async () => ({ text: '{"save": false, "bullets": []}', usage: null }))
    });
    expect((await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "hi" }, noSave)).saved).toEqual(
      []
    );
    expect(noSave.append).not.toHaveBeenCalled();
  });

  it("reports duplicate-only appends without a saved log line", async () => {
    const deps = makeDeps({
      append: vi.fn(async () => ({
        appended: false,
        savedBullets: [],
        skippedDuplicates: 1,
        memoryChars: 10,
        truncated: false
      }))
    });
    const res = await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, deps);
    expect(res.saved).toEqual([]);
  });

  it("never throws — an append failure resolves to a no-op", async () => {
    const deps = makeDeps({
      append: vi.fn(async () => {
        throw new Error("write failed");
      })
    });
    const res = await captureOwnerRuleInline({ businessId: BIZ, ownerMessage: "rule" }, deps);
    expect(res.saved).toEqual([]);
  });
});
