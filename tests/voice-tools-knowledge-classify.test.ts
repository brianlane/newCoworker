import { describe, expect, it } from "vitest";

import { classifyGeminiError } from "@/app/api/voice/tools/knowledge/route";

/**
 * These assertions pin down the cursor bugbot report: the knowledge route
 * must NOT collapse every Gemini failure into "timeout". Each branch here
 * corresponds to a real upstream signal the voice bridge forwards back to
 * Gemini Live as `detail`, and getting it wrong changes both the spoken
 * fallback and operational telemetry.
 */
describe("classifyGeminiError", () => {
  it("maps AbortError to timeout", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(classifyGeminiError(err)).toBe("timeout");
  });

  it("falls back to timeout when the message hints at an abort but the name is generic", () => {
    expect(classifyGeminiError(new Error("fetch failed: The user aborted a request."))).toBe("timeout");
  });

  it("maps gemini_unavailable (missing API key) to summarizer_unavailable", () => {
    expect(classifyGeminiError(new Error("gemini_unavailable"))).toBe("summarizer_unavailable");
  });

  it("maps gemini_empty to empty_answer", () => {
    expect(classifyGeminiError(new Error("gemini_empty"))).toBe("empty_answer");
  });

  it("maps 429 to rate_limited", () => {
    expect(classifyGeminiError(new Error("gemini_http_429"))).toBe("rate_limited");
  });

  it("maps 5xx to upstream_error", () => {
    expect(classifyGeminiError(new Error("gemini_http_500"))).toBe("upstream_error");
    expect(classifyGeminiError(new Error("gemini_http_503"))).toBe("upstream_error");
  });

  it("maps other 4xx to upstream_client_error", () => {
    expect(classifyGeminiError(new Error("gemini_http_400"))).toBe("upstream_client_error");
    expect(classifyGeminiError(new Error("gemini_http_401"))).toBe("upstream_client_error");
  });

  it("falls through to gemini_error for unknown messages and non-Error throws", () => {
    expect(classifyGeminiError(new Error("something weird"))).toBe("gemini_error");
    expect(classifyGeminiError("string")).toBe("gemini_error");
    expect(classifyGeminiError(null)).toBe("gemini_error");
  });
});
