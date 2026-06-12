/**
 * Direct tests for the shared business-knowledge core
 * (src/lib/knowledge-tools/handlers.ts) used by the voice adapter and the
 * Rowboat tool webhook. classifyGeminiError's branch matrix is pinned in
 * tests/voice-tools-knowledge-classify.test.ts via the route re-export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/configs", () => ({ getBusinessConfig: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/gemini-generate-content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini-generate-content")>()),
  geminiGenerateTextDetailed: vi.fn()
}));
vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));

import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import { getBusinessConfig } from "@/lib/db/configs";
import { getBusiness } from "@/lib/db/businesses";
import { GeminiEmptyError, geminiGenerateTextDetailed } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";

const BIZ = "11111111-1111-4111-8111-111111111111";

const gemini = vi.mocked(geminiGenerateTextDetailed);
const meter = vi.mocked(meterGeminiSpendForBusiness);

function geminiOk(text: string, usage: { promptTokens: number; outputTokens: number } | null) {
  return { text, usage };
}

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GEMINI_ROWBOAT_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_ROWBOAT_MODEL;
  meter.mockResolvedValue(undefined);
  vi.mocked(getBusiness).mockResolvedValue({ name: "Amy Laidlaw Team" } as never);
  vi.mocked(getBusinessConfig).mockResolvedValue({
    identity_md: "identity",
    soul_md: "soul",
    website_md: "website",
    memory_md: "memory"
  } as never);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("lookupBusinessKnowledge", () => {
  it("answers from the vault context and meters the spend with exact usage", async () => {
    gemini.mockResolvedValue(geminiOk("Open 9-5 weekdays.", { promptTokens: 900, outputTokens: 20 }));
    const result = await lookupBusinessKnowledge(BIZ, "What are your hours?");
    expect(result).toEqual({ ok: true, data: { answer: "Open 9-5 weekdays." } });
    const call = gemini.mock.calls[0][0];
    expect(call.userText).toContain("Business name: Amy Laidlaw Team");
    expect(call.userText).toContain("# website.md");
    expect(call.userText).toContain("Caller question: What are your hours?");

    expect(meter).toHaveBeenCalledOnce();
    expect(meter.mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      model: "gemini-3-flash-preview",
      surface: "knowledge_lookup",
      usage: { promptTokens: 900, outputTokens: 20 },
      outputChars: "Open 9-5 weekdays.".length
    });
    expect(meter.mock.calls[0][0].inputChars).toBeGreaterThan(0);
  });

  it("meters with null usage when the response carried no usageMetadata", async () => {
    gemini.mockResolvedValue(geminiOk("answer", null));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result.ok).toBe(true);
    expect(meter.mock.calls[0][0].usage).toBeNull();
  });

  it("returns knowledge_empty when the vault has no content", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    vi.mocked(getBusinessConfig).mockResolvedValue(null as never);
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "knowledge_empty" });
    expect(gemini).not.toHaveBeenCalled();
    expect(meter).not.toHaveBeenCalled();
  });

  it("maps a missing API key to summarizer_unavailable", async () => {
    delete process.env.GOOGLE_API_KEY;
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "summarizer_unavailable" });
    expect(meter).not.toHaveBeenCalled();
  });

  it("accepts GEMINI_API_KEY as the key source", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "alt-key";
    gemini.mockResolvedValue(geminiOk("answer", null));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result.ok).toBe(true);
    expect(gemini.mock.calls[0][0].apiKey).toBe("alt-key");
  });

  it("retries the default model when a configured override 404s and meters the fallback model", async () => {
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-9.9-nonexistent";
    gemini
      .mockRejectedValueOnce(new Error("gemini_http_404: model not found"))
      .mockResolvedValueOnce(geminiOk("fallback answer", { promptTokens: 5, outputTokens: 3 }));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: true, data: { answer: "fallback answer" } });
    expect(gemini.mock.calls[0][0].model).toBe("gemini-9.9-nonexistent");
    expect(gemini.mock.calls[1][0].model).toBe("gemini-3-flash-preview");
    expect(meter.mock.calls[0][0].model).toBe("gemini-3-flash-preview");
  });

  it("does NOT retry when the default model itself 404s", async () => {
    gemini.mockRejectedValue(new Error("gemini_http_404: gone"));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "upstream_client_error" });
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(meter).not.toHaveBeenCalled();
  });

  it("aborts a hung Gemini call after the 3s deadline (timeout)", async () => {
    vi.useFakeTimers();
    try {
      gemini.mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );
      const pending = lookupBusinessKnowledge(BIZ, "hours?");
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toEqual({ ok: false, detail: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("meters a billed-but-empty reply (thinking-only output) before classifying it", async () => {
    gemini.mockRejectedValue(new GeminiEmptyError({ promptTokens: 800, outputTokens: 200 }));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "empty_answer" });
    expect(meter).toHaveBeenCalledOnce();
    expect(meter.mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      model: "gemini-3-flash-preview",
      surface: "knowledge_lookup",
      usage: { promptTokens: 800, outputTokens: 200 },
      outputChars: 0
    });
  });

  it("tolerates non-Error throw values (classified as gemini_error)", async () => {
    gemini.mockRejectedValue("string failure");
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "gemini_error" });
  });

  it("classifies non-404 upstream failures (e.g. 500 → upstream_error)", async () => {
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-custom";
    gemini.mockRejectedValue(new Error("gemini_http_500: boom"));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "upstream_error" });
    expect(gemini).toHaveBeenCalledTimes(1);
  });
});
