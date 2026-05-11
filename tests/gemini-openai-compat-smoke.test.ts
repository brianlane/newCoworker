import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { smokeTestGeminiOpenAiSummarizer } from "@/lib/website-ingest";

describe("smokeTestGeminiOpenAiSummarizer (offline)", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.GOOGLE_API_KEY = "offline-test-key";
    delete process.env.GEMINI_SUMMARY_MODEL;
    delete process.env.GEMINI_ROWBOAT_MODEL;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs to Gemini OpenAI-compatible chat completions endpoint", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ choices: [{ message: { content: " OK_GEMINI_SMOKE " } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await smokeTestGeminiOpenAiSummarizer();
    expect(out).toContain("OK_GEMINI_SMOKE");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    const [, init] = fetchMock.mock.calls[0]!;
    const parsed = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages?.[1]?.role).toBe("user");
  });
});
