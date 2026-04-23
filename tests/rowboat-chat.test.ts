import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assistantFromRowboat,
  buildRowboatChatUrl,
  callRowboatChat,
  DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE,
  describeRowboatError,
  parseRowboatChatJson
} from "@/lib/rowboat/chat";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PROJ = "proj-42";
const originalTemplate = process.env.ROWBOAT_CHAT_URL_TEMPLATE;

beforeEach(() => {
  delete process.env.ROWBOAT_CHAT_URL_TEMPLATE;
});

afterEach(() => {
  if (originalTemplate === undefined) delete process.env.ROWBOAT_CHAT_URL_TEMPLATE;
  else process.env.ROWBOAT_CHAT_URL_TEMPLATE = originalTemplate;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("buildRowboatChatUrl", () => {
  it("substitutes both {businessId} and {projectId} using the default template", () => {
    expect(buildRowboatChatUrl(BIZ, PROJ)).toBe(
      `https://${BIZ}.tunnel.newcoworker.com/api/v1/${PROJ}/chat`
    );
  });

  it("uses ROWBOAT_CHAT_URL_TEMPLATE override and replaces every placeholder occurrence", () => {
    process.env.ROWBOAT_CHAT_URL_TEMPLATE =
      "https://rb.test/{businessId}/{projectId}/{businessId}";
    expect(buildRowboatChatUrl("b1", "p1")).toBe("https://rb.test/b1/p1/b1");
  });

  it("exports the known default template so tests can assert routing shape", () => {
    expect(DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE).toContain("{businessId}");
    expect(DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE).toContain("{projectId}");
  });
});

describe("assistantFromRowboat / parseRowboatChatJson", () => {
  it("extracts the first assistant turn and trims whitespace", () => {
    const json = {
      conversationId: "c1",
      turn: {
        output: [
          { role: "tool", content: "ignored" },
          { role: "assistant", content: "  hello world  " }
        ]
      }
    };
    expect(assistantFromRowboat(json)).toBe("hello world");
  });

  it("returns empty string when there are no assistant messages", () => {
    expect(assistantFromRowboat({ turn: { output: [] } })).toBe("");
    expect(assistantFromRowboat({ turn: { output: [{ role: "tool", content: "x" }] } })).toBe("");
    expect(assistantFromRowboat({})).toBe("");
    expect(
      assistantFromRowboat({
        turn: { output: [{ role: "assistant", content: "   " }] }
      })
    ).toBe("");
    expect(
      assistantFromRowboat({
        turn: { output: [{ role: "assistant", content: null }] }
      })
    ).toBe("");
  });

  it("parseRowboatChatJson surfaces hasStateKey=true even when state is null", () => {
    const parsed = parseRowboatChatJson({
      conversationId: "c1",
      state: null,
      turn: { output: [{ role: "assistant", content: "ok" }] }
    });
    expect(parsed.hasStateKey).toBe(true);
    expect(parsed.state).toBeNull();
    expect(parsed.reply).toBe("ok");
    expect(parsed.conversationId).toBe("c1");
  });

  it("parseRowboatChatJson reports hasStateKey=false when state key is absent", () => {
    const parsed = parseRowboatChatJson({
      conversationId: "c1",
      turn: { output: [{ role: "assistant", content: "ok" }] }
    });
    expect(parsed.hasStateKey).toBe(false);
    expect(parsed.state).toBeUndefined();
  });

  it("parseRowboatChatJson handles non-object inputs without throwing", () => {
    expect(parseRowboatChatJson(null).hasStateKey).toBe(false);
    expect(parseRowboatChatJson("oops").hasStateKey).toBe(false);
  });
});

describe("callRowboatChat", () => {
  function mockResponse(init: {
    ok: boolean;
    status: number;
    jsonBody?: unknown;
    jsonThrows?: boolean;
  }): Response {
    return {
      ok: init.ok,
      status: init.status,
      json: async () => {
        if (init.jsonThrows) throw new Error("bad json");
        return init.jsonBody;
      }
    } as unknown as Response;
  }

  it("posts the expected body and returns the parsed turn on success", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: {
          conversationId: "c-new",
          state: { step: 1 },
          turn: { output: [{ role: "assistant", content: "hi" }] }
        }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const out = await callRowboatChat({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hey" }],
      conversationId: "prev",
      state: { k: "v" }
    });

    expect(out.reply).toBe("hi");
    expect(out.conversationId).toBe("c-new");
    expect(out.state).toEqual({ step: 1 });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${BIZ}.tunnel.newcoworker.com/api/v1/${PROJ}/chat`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer B");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.conversationId).toBe("prev");
    expect(body.state).toEqual({ k: "v" });
    expect(body.messages).toHaveLength(1);
  });

  it("omits conversationId+state when not provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { turn: { output: [{ role: "assistant", content: "ok" }] } }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);
    await callRowboatChat({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "x" }]
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("conversationId");
    expect(body).not.toHaveProperty("state");
  });

  it("omits state when conversationId is set but state is null/undefined", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { turn: { output: [{ role: "assistant", content: "ok" }] } }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);
    await callRowboatChat({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "x" }],
      conversationId: "prev",
      state: null
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    ) as Record<string, unknown>;
    expect(body.conversationId).toBe("prev");
    expect(body).not.toHaveProperty("state");
  });

  it("treats an empty conversationId string as unset", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { turn: { output: [{ role: "assistant", content: "ok" }] } }
      })
    );
    vi.stubGlobal("fetch", fetchSpy);
    await callRowboatChat({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "x" }],
      conversationId: "   "
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("conversationId");
  });

  it("throws rowboat_http_<status> on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 503 }))
    );
    await expect(
      callRowboatChat({
        businessId: BIZ,
        projectId: PROJ,
        bearer: "B",
        messages: [{ role: "user", content: "x" }]
      })
    ).rejects.toThrow("rowboat_http_503");
  });

  it("throws rowboat_invalid_json when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200, jsonThrows: true }))
    );
    await expect(
      callRowboatChat({
        businessId: BIZ,
        projectId: PROJ,
        bearer: "B",
        messages: [{ role: "user", content: "x" }]
      })
    ).rejects.toThrow("rowboat_invalid_json");
  });

  it("throws rowboat_empty_assistant when reply is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          jsonBody: { turn: { output: [] } }
        })
      )
    );
    await expect(
      callRowboatChat({
        businessId: BIZ,
        projectId: PROJ,
        bearer: "B",
        messages: [{ role: "user", content: "x" }]
      })
    ).rejects.toThrow("rowboat_empty_assistant");
  });

  it("throws rowboat_timeout when the abort signal fires", async () => {
    // Simulate a fetch that aborts when the controller fires.
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })
    );
    await expect(
      callRowboatChat({
        businessId: BIZ,
        projectId: PROJ,
        bearer: "B",
        messages: [{ role: "user", content: "x" }],
        timeoutMs: 5
      })
    ).rejects.toThrow("rowboat_timeout");
  });

  it("propagates non-abort fetch errors untouched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(
      callRowboatChat({
        businessId: BIZ,
        projectId: PROJ,
        bearer: "B",
        messages: [{ role: "user", content: "x" }]
      })
    ).rejects.toThrow("ECONNRESET");
  });
});

describe("describeRowboatError", () => {
  it("returns owner-friendly copy for each known error class", () => {
    expect(describeRowboatError(new Error("rowboat_timeout"))).toMatch(/too long/);
    expect(describeRowboatError(new Error("rowboat_empty_assistant"))).toMatch(
      /didn.?t produce/
    );
    expect(describeRowboatError(new Error("rowboat_invalid_json"))).toMatch(
      /unexpected response/
    );
    expect(describeRowboatError(new Error("rowboat_http_401"))).toMatch(/auth/);
    expect(describeRowboatError(new Error("rowboat_http_403"))).toMatch(/auth/);
    expect(describeRowboatError(new Error("rowboat_http_404"))).toMatch(/provisioning/i);
    expect(describeRowboatError(new Error("rowboat_http_500"))).toMatch(/status 500/);
  });

  it("falls back to a generic message for unknown errors and non-Error inputs", () => {
    expect(describeRowboatError(new Error("weird"))).toMatch(/couldn.?t reach/);
    expect(describeRowboatError("nope")).toMatch(/couldn.?t reach/);
    expect(describeRowboatError(null)).toMatch(/couldn.?t reach/);
  });
});
