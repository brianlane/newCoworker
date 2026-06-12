import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiEmptyError,
  geminiGenerateText,
  geminiGenerateTextDetailed
} from "@/lib/gemini-generate-content";

type FetchArgs = Parameters<typeof fetch>;

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("geminiGenerateTextDetailed usage extraction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const candidates = [{ content: { parts: [{ text: "hi" }] } }];

  async function runWith(usageMetadata: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => okResponse({ candidates, usageMetadata }))
    );
    return geminiGenerateTextDetailed({
      apiKey: "k",
      model: "m",
      systemInstruction: "s",
      userText: "u"
    });
  }

  it("sums candidate and thinking tokens into outputTokens", async () => {
    const res = await runWith({
      promptTokenCount: 1200,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 500
    });
    expect(res.text).toBe("hi");
    expect(res.usage).toEqual({ promptTokens: 1200, outputTokens: 580 });
  });

  it("defaults missing token fields to 0", async () => {
    const res = await runWith({ promptTokenCount: 10 });
    expect(res.usage).toEqual({ promptTokens: 10, outputTokens: 0 });
  });

  it("defaults a missing promptTokenCount to 0", async () => {
    const res = await runWith({ candidatesTokenCount: 5 });
    expect(res.usage).toEqual({ promptTokens: 0, outputTokens: 5 });
  });

  it("returns null usage when usageMetadata is absent", async () => {
    const res = await runWith(undefined);
    expect(res.usage).toBeNull();
  });

  it("returns null usage when usageMetadata is not an object", async () => {
    const res = await runWith("bogus");
    expect(res.usage).toBeNull();
  });

  it("returns null usage when promptTokenCount is non-numeric", async () => {
    const res = await runWith({ promptTokenCount: "x", candidatesTokenCount: 1 });
    expect(res.usage).toBeNull();
  });

  it("returns null usage when candidatesTokenCount is non-numeric", async () => {
    const res = await runWith({ promptTokenCount: 1, candidatesTokenCount: "x" });
    expect(res.usage).toBeNull();
  });

  it("returns null usage when thoughtsTokenCount is non-numeric", async () => {
    const res = await runWith({ promptTokenCount: 1, thoughtsTokenCount: "x" });
    expect(res.usage).toBeNull();
  });

  it("returns null usage when all counts are zero", async () => {
    const res = await runWith({ promptTokenCount: 0, candidatesTokenCount: 0 });
    expect(res.usage).toBeNull();
  });

  it("clamps negative counts to 0", async () => {
    const res = await runWith({
      promptTokenCount: -5,
      candidatesTokenCount: 7,
      thoughtsTokenCount: -3
    });
    expect(res.usage).toEqual({ promptTokens: 0, outputTokens: 7 });
  });

  it("throws GeminiEmptyError carrying billed usage when text is empty (thinking-only output)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          okResponse({
            candidates: [{ content: { parts: [] } }],
            usageMetadata: { promptTokenCount: 800, thoughtsTokenCount: 200 }
          })
      )
    );
    const pending = geminiGenerateTextDetailed({
      apiKey: "k",
      model: "m",
      systemInstruction: "s",
      userText: "u"
    });
    await expect(pending).rejects.toThrow("gemini_empty");
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(GeminiEmptyError);
    expect((err as GeminiEmptyError).usage).toEqual({ promptTokens: 800, outputTokens: 200 });
  });
});

describe("geminiGenerateText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs generateContent with x-goog-api-key and returns candidate text", async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "  hello worlds  " }, { text: "!" }] } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await geminiGenerateText({
      apiKey: "test-key",
      model: " gemini-flash-preview ",
      systemInstruction: "sys",
      userText: "user",
      temperature: 0.3,
      maxOutputTokens: 99
    });
    expect(out).toBe("hello worlds  !");

    expect(fetchMock).toHaveBeenCalledOnce();
    const tuple = fetchMock.mock.calls.at(0) as FetchArgs | undefined;
    expect(tuple).toBeDefined();
    const [url, init] = tuple!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-preview:generateContent"
    );
    const headers = new Headers(init?.headers ?? undefined);
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    const parsed = JSON.parse(String(init?.body ?? "{}"));
    expect(parsed.systemInstruction.parts[0].text).toBe("sys");
    expect(parsed.contents[0].parts[0].text).toBe("user");
    expect(parsed.generationConfig).toMatchObject({ temperature: 0.3, maxOutputTokens: 99 });
  });

  it("uses default generationConfig temperature and maxOutputTokens", async () => {
    const fetchStub = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchStub);

    await geminiGenerateText({
      apiKey: "k",
      model: "m",
      systemInstruction: "s",
      userText: "u"
    });

    const tup = fetchStub.mock.calls.at(0) as FetchArgs | undefined;
    expect(tup).toBeDefined();
    const [, init] = tup!;
    const parsed = JSON.parse(String(init?.body ?? "{}"));
    expect(parsed.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 1500 });
  });

  it("throws gemini_http_<status> with a truncated body on non-OK responses", async () => {
    const longBody = "x".repeat(300);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(longBody, { status: 403, headers: { "content-type": "application/json" } })
      )
    );

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow(/^gemini_http_403:x{200}$/);
  });

  it("uses an empty suffix when response.text rejects on error responses", async () => {
    const brokenBody: Partial<Response> = {
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error("broken stream"))
    };
    vi.stubGlobal("fetch", vi.fn(async () => brokenBody as Response));

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow(/^gemini_http_502:$/);
  });

  it("throws gemini_http_parse when JSON is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow("gemini_http_parse");
  });

  it("throws gemini_empty when there is no extractable candidate text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ candidates: [] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow("gemini_empty");
  });

  it("throws gemini_empty when candidates exist but candidate text trims to empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "  \t" }] } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow("gemini_empty");
  });

  it("throws gemini_empty when parts is empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow("gemini_empty");
  });

  it("throws gemini_empty when parts is missing or non-array content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: null } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow("gemini_empty");
  });

  it("throws gemini_empty when parts omit text entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{}] } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await expect(
      geminiGenerateText({
        apiKey: "k",
        model: "m",
        systemInstruction: "s",
        userText: "u"
      })
    ).rejects.toThrow("gemini_empty");
  });

  it("treats null JSON array entries as blank parts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [null, { text: "x" }] } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const out = await geminiGenerateText({
      apiKey: "k",
      model: "m",
      systemInstruction: "s",
      userText: "u"
    });
    expect(out).toBe("x");
  });
});
