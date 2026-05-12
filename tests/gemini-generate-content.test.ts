import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiGenerateText } from "@/lib/gemini-generate-content";

type FetchArgs = Parameters<typeof fetch>;

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
