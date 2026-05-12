import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { smokeTestGeminiOpenAiSummarizer } from "@/lib/website-ingest";

type FetchArgs = Parameters<typeof fetch>;

describe("smokeTestGeminiOpenAiSummarizer (offline, generateContent)", () => {
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

  it("POSTs to Gemini generateContent for the ingest summarizer ping", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: " OK_GEMINI_SMOKE " }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await smokeTestGeminiOpenAiSummarizer();
    expect(out).toContain("OK_GEMINI_SMOKE");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tuple = fetchMock.mock.calls.at(0) as FetchArgs | undefined;
    expect(tuple).toBeDefined();
    const [url, init] = tuple!;
    expect(String(url)).toMatch(/generateContent$/);
    const parsed = JSON.parse(String(init?.body ?? "{}"));
    expect(parsed.contents).toHaveLength(1);
    expect(parsed.contents?.[0]?.role).toBe("user");
  });
});
