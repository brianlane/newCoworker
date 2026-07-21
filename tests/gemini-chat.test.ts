import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFunctionResponseContent,
  geminiChatStep,
  type GeminiFunctionDeclaration
} from "@/lib/gemini-chat";

const TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: "webchat_capture_lead",
    description: "capture",
    parameters: { type: "object", properties: {}, required: [] }
  }
];

const BASE = {
  apiKey: "test-key",
  model: "gemini-2.5-flash-lite",
  systemInstruction: "You are a widget.",
  contents: [{ role: "user" as const, parts: [{ text: "hi" }] }],
  tools: TOOLS
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geminiChatStep", () => {
  it("returns joined text + usage on a plain answer", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        candidates: [{ content: { parts: [{ text: "Hello " }, { text: "there." }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 }
      })
    );
    const res = await geminiChatStep(BASE);
    expect(res.text).toBe("Hello there.");
    expect(res.functionCalls).toEqual([]);
    expect(res.usage).toEqual({ promptTokens: 10, outputTokens: 6 });
    expect(res.modelContent).toEqual({
      role: "model",
      parts: [{ text: "Hello " }, { text: "there." }]
    });

    // Request shape: tools attached, system instruction + defaults present.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent"
    );
    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction.parts[0].text).toBe("You are a widget.");
    expect(body.tools).toEqual([{ functionDeclarations: TOOLS }]);
    expect(body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 1500 });
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("omits the tools field entirely when the caller passes none", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ candidates: [{ content: { parts: [{ text: "final" }] } }] })
    );
    const res = await geminiChatStep({ ...BASE, tools: [], temperature: 0.7, maxOutputTokens: 99 });
    expect(res.text).toBe("final");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig).toEqual({ temperature: 0.7, maxOutputTokens: 99 });
  });

  it("threads thinkingLevel into generationConfig.thinkingConfig when set", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })
    );
    await geminiChatStep({ ...BASE, thinkingLevel: "low" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("extracts functionCall parts and coerces malformed args to {}", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "webchat_capture_lead", args: { name: "Ann" } } },
                { functionCall: { name: "webchat_calendar_find_slots", args: ["not-an-object"] } },
                { functionCall: { name: "" } },
                { functionCall: { args: {} } },
                null
              ]
            }
          }
        ]
      })
    );
    const res = await geminiChatStep(BASE);
    expect(res.text).toBeNull();
    expect(res.functionCalls).toEqual([
      { name: "webchat_capture_lead", args: { name: "Ann" } },
      { name: "webchat_calendar_find_slots", args: {} }
    ]);
    // Null parts are filtered from the echoed model content.
    expect(res.modelContent?.parts).toHaveLength(4);
  });

  it("returns empty result when the response has no candidates / no parts", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ candidates: [] }));
    const empty = await geminiChatStep(BASE);
    expect(empty).toEqual({ text: null, functionCalls: [], modelContent: null, usage: null });

    fetchMock.mockResolvedValueOnce(okResponse({ candidates: [{ content: { parts: [] } }] }));
    const noParts = await geminiChatStep(BASE);
    expect(noParts.modelContent).toBeNull();

    fetchMock.mockResolvedValueOnce(okResponse({}));
    const bare = await geminiChatStep(BASE);
    expect(bare.modelContent).toBeNull();
  });

  it("treats whitespace-only text parts as no text", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ candidates: [{ content: { parts: [{ text: "   " }] } }] })
    );
    const res = await geminiChatStep(BASE);
    expect(res.text).toBeNull();
  });

  it("throws gemini_http_<status> with a bounded body excerpt on non-OK", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom".repeat(100), { status: 500 }));
    await expect(geminiChatStep(BASE)).rejects.toThrow(/^gemini_http_500:/);
  });

  it("swallows a body read failure on the non-OK path", async () => {
    const res = new Response(null, { status: 429 });
    vi.spyOn(res, "text").mockRejectedValueOnce(new Error("read fail"));
    fetchMock.mockResolvedValueOnce(res);
    await expect(geminiChatStep(BASE)).rejects.toThrow("gemini_http_429:");
  });

  it("throws gemini_http_parse on an unparseable success body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(geminiChatStep(BASE)).rejects.toThrow("gemini_http_parse");
  });
});

describe("buildFunctionResponseContent", () => {
  it("wraps each result in a functionResponse part on one user turn", () => {
    const content = buildFunctionResponseContent([
      { name: "a", response: { ok: true } },
      { name: "b", response: { ok: false, detail: "x" } }
    ]);
    expect(content).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "a", response: { result: { ok: true } } } },
        { functionResponse: { name: "b", response: { result: { ok: false, detail: "x" } } } }
      ]
    });
  });
});
