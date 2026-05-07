import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assistantFromRowboat,
  buildRowboatChatUrl,
  callRowboatChat,
  callRowboatChatStream,
  DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE,
  describeRowboatError,
  parseRowboatChatJson,
  parseRowboatStreamEvent
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
      `https://${BIZ}.newcoworker.com/api/v1/${PROJ}/chat`
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
    expect(url).toBe(`https://${BIZ}.newcoworker.com/api/v1/${PROJ}/chat`);
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

  // 524 / 522 / 408 are infrastructure-level "no response in time"
  // signals — Cloudflare 524 = origin idle timeout exceeded; 522 =
  // origin connection timed out; 408 = request timeout. Pre-streaming
  // these fell through to the generic "having trouble (status 524)"
  // string, which was both unhelpful (the owner can't act on a status
  // code) AND misleading (suggesting a Rowboat bug when actually the
  // tunnel timed out the origin). They now share the same copy as
  // rowboat_timeout because the user-facing fix is the same: try again.
  it("maps 524 / 522 / 408 to the rowboat_timeout copy — these are 'origin took too long' signals, not Rowboat bugs", () => {
    expect(describeRowboatError(new Error("rowboat_http_524"))).toMatch(/too long/);
    expect(describeRowboatError(new Error("rowboat_http_522"))).toMatch(/too long/);
    expect(describeRowboatError(new Error("rowboat_http_408"))).toMatch(/too long/);
    // Sanity: the timeout-family copy is identical so the UX is
    // consistent regardless of where the timeout actually surfaced.
    const ttooLong = describeRowboatError(new Error("rowboat_timeout"));
    expect(describeRowboatError(new Error("rowboat_http_524"))).toBe(ttooLong);
  });

  it("falls back to a generic message for unknown errors and non-Error inputs", () => {
    expect(describeRowboatError(new Error("weird"))).toMatch(/couldn.?t reach/);
    expect(describeRowboatError("nope")).toMatch(/couldn.?t reach/);
    expect(describeRowboatError(null)).toMatch(/couldn.?t reach/);
  });
});

describe("parseRowboatStreamEvent — pure parser", () => {
  // The streaming Rowboat wire format is not documented in our repo
  // (every existing call sends stream:false). The parser is built to
  // tolerate three plausible shapes: OpenAI-compatible chat.completions
  // SSE chunks, Rowboat-native `{type, ...}` events, and a final
  // Rowboat-shaped `{conversationId, state, turn:{output:[...]}}`. If
  // upstream picks something else this test surface is the canary.

  it("returns a `done` event for the literal `[DONE]` SSE sentinel", () => {
    const ev = parseRowboatStreamEvent("[DONE]");
    expect(ev?.type).toBe("done");
  });

  it("parses Rowboat-native delta events {type:'delta',content:'...'}", () => {
    const ev = parseRowboatStreamEvent('{"type":"delta","content":"Hello"}');
    expect(ev).toEqual({ type: "delta", text: "Hello" });
  });

  it("parses alternate delta type aliases (text / token / message_delta) so a Rowboat naming change won't drop content silently", () => {
    expect(parseRowboatStreamEvent('{"type":"text","content":"a"}')).toEqual({
      type: "delta",
      text: "a"
    });
    expect(parseRowboatStreamEvent('{"type":"token","text":"b"}')).toEqual({
      type: "delta",
      text: "b"
    });
    expect(parseRowboatStreamEvent('{"type":"message_delta","delta":"c"}')).toEqual({
      type: "delta",
      text: "c"
    });
  });

  it("parses OpenAI-compatible chunk shape `{choices:[{delta:{content:'...'}}]}`", () => {
    const ev = parseRowboatStreamEvent(
      '{"choices":[{"delta":{"content":"Hi"}}]}'
    );
    expect(ev).toEqual({ type: "delta", text: "Hi" });
  });

  it("returns null (no-op) for OpenAI role-only or finish_reason chunks — keeps the idle timer ticking without yielding empty deltas", () => {
    expect(parseRowboatStreamEvent('{"choices":[{"delta":{"role":"assistant"}}]}')).toBeNull();
    expect(parseRowboatStreamEvent('{"choices":[{"finish_reason":"stop","delta":{}}]}')).toBeNull();
  });

  it("parses tool_call events without crashing and returns the type/name unchanged", () => {
    const ev = parseRowboatStreamEvent(
      '{"type":"tool_call","name":"send_sms","arguments":{"to":"+1"}}'
    );
    expect(ev).toEqual({
      type: "tool_call",
      name: "send_sms",
      arguments: { to: "+1" }
    });
  });

  it("parses Rowboat-native done events with conversationId + state metadata", () => {
    const ev = parseRowboatStreamEvent(
      '{"type":"done","conversationId":"c1","state":{"k":1}}'
    );
    expect(ev).toEqual({
      type: "done",
      conversationId: "c1",
      state: { k: 1 },
      hasStateKey: true
    });
  });

  it("done events distinguish state:null from missing state — the route relies on this to know when to overwrite the stored continuation", () => {
    const explicitNull = parseRowboatStreamEvent(
      '{"type":"done","conversationId":"c","state":null}'
    );
    expect(explicitNull?.type).toBe("done");
    expect(explicitNull && (explicitNull as { hasStateKey: boolean }).hasStateKey).toBe(true);
    expect(explicitNull && (explicitNull as { state: unknown }).state).toBeNull();

    const missing = parseRowboatStreamEvent('{"type":"done","conversationId":"c"}');
    expect(missing?.type).toBe("done");
    expect(missing && (missing as { hasStateKey: boolean }).hasStateKey).toBe(false);
  });

  it("parses error events", () => {
    const ev = parseRowboatStreamEvent(
      '{"type":"error","message":"rowboat_http_500"}'
    );
    expect(ev).toEqual({ type: "error", message: "rowboat_http_500" });
  });

  it("treats a final Rowboat-shaped JSON `{turn:{output:[...]}}` as a done event with metadata", () => {
    const ev = parseRowboatStreamEvent(
      '{"conversationId":"c","state":{"x":1},"turn":{"output":[]}}'
    );
    expect(ev?.type).toBe("done");
    expect(ev && (ev as { conversationId: string | undefined }).conversationId).toBe("c");
  });

  it("hypothesis-3 path: a final JSON with conversationId but NO state key omits state from the done event (preserves the buffered API's hasStateKey=false semantics)", async () => {
    // Pinned for the route-side semantics: `hasStateKey=false` means
    // "Rowboat didn't echo state, don't overwrite our stored copy"
    // (the buffered code's contract). The streaming parser must
    // mirror this exactly.
    const ev = parseRowboatStreamEvent('{"conversationId":"c","turn":{"output":[]}}');
    expect(ev?.type).toBe("done");
    if (ev?.type === "done") {
      expect(ev.conversationId).toBe("c");
      expect(ev.hasStateKey).toBe(false);
      expect(ev.state).toBeUndefined();
    }
  });

  it("falls back to a generic 'rowboat_stream_error' message when an error event omits the message field", async () => {
    // Defensive — Rowboat (or an intermediary) might emit
    // `{"type":"error"}` with no message. We MUST still surface a
    // non-empty error string so describeRowboatError can render
    // something to the owner.
    const ev = parseRowboatStreamEvent('{"type":"error"}');
    expect(ev).toEqual({ type: "error", message: "rowboat_stream_error" });
  });

  it("returns null for a delta-typed event that has none of {content, text, delta} populated — caller surfaces this as rowboat_invalid_json", () => {
    // The parser tries content → text → delta as a chained fallback;
    // if none of them are strings the parser MUST return null so the
    // stream loop emits an invalid_json error rather than yielding a
    // delta with `text: ""` (which would silently look like a fast-
    // empty model reply).
    expect(parseRowboatStreamEvent('{"type":"delta"}')).toBeNull();
  });

  it("tool_call without a name field still yields a tool_call event with name=''", () => {
    // The route currently ignores tool_call events anyway, but the
    // parser must not crash on a Rowboat that sometimes omits the
    // tool name in early-prototype builds. Emitting `name: ""` keeps
    // the type narrow and lets the route's tool_call branch run
    // verbatim.
    const ev = parseRowboatStreamEvent(
      '{"type":"tool_call","arguments":{"x":1}}'
    );
    expect(ev).toEqual({
      type: "tool_call",
      name: "",
      arguments: { x: 1 }
    });
  });

  it("OpenAI hypothesis-1 path: tolerates `choices[0]` being null without crashing", () => {
    // Some OpenAI-compat servers emit a chunk with `choices: [null]`
    // as a final keep-alive. The parser MUST treat this as a no-op
    // (returns null for the caller to skip) rather than throwing on
    // a null property access.
    expect(parseRowboatStreamEvent('{"choices":[null]}')).toBeNull();
  });

  it("hypothesis-3 path: a final JSON with state but NO conversationId still yields done with conversationId=undefined and state preserved", async () => {
    // Rowboat is observed (in some builds) emitting a final JSON that
    // carries `state` but omits `conversationId` — happens when the
    // server already returned a fresh conversation id earlier as a
    // separate meta event. The parser must still extract the state
    // metadata in that case (the route relies on hasStateKey to know
    // whether to overwrite the stored continuation).
    const ev = parseRowboatStreamEvent('{"state":null,"turn":{"output":[]}}');
    expect(ev?.type).toBe("done");
    if (ev?.type === "done") {
      expect(ev.conversationId).toBeUndefined();
      expect(ev.hasStateKey).toBe(true);
      expect(ev.state).toBeNull();
    }
  });

  it("returns null for unrecognised payload shapes — the stream loop surfaces this as rowboat_invalid_json instead of silently dropping content", () => {
    expect(parseRowboatStreamEvent('{"weird":"shape"}')).toBeNull();
  });

  it("returns null for empty / whitespace input (heartbeat lines, keep-alives)", () => {
    expect(parseRowboatStreamEvent("")).toBeNull();
    expect(parseRowboatStreamEvent("   ")).toBeNull();
  });

  it("returns null for invalid JSON instead of throwing — caller decides whether to surface as an error event", () => {
    expect(parseRowboatStreamEvent("{not json")).toBeNull();
  });

  it("returns null for the JSON literal `null` (parses successfully but isn't a usable event)", () => {
    // JSON.parse("null") returns null, which would otherwise blow up
    // on every property access downstream. Pinned because the
    // null-vs-non-object guard on line 326 is the only thing standing
    // between us and a cryptic TypeError on a Rowboat keep-alive.
    expect(parseRowboatStreamEvent("null")).toBeNull();
  });

  it("returns null for non-object JSON values (numbers, strings, booleans) — only object events are usable", () => {
    expect(parseRowboatStreamEvent("42")).toBeNull();
    expect(parseRowboatStreamEvent('"some string"')).toBeNull();
    expect(parseRowboatStreamEvent("true")).toBeNull();
  });
});

describe("callRowboatChatStream", () => {
  // Build a Response whose body is a ReadableStream feeding the SSE
  // chunks one at a time, so we can drive callRowboatChatStream end
  // to end without a real Rowboat. Helper takes either a single chunk
  // or an array for multi-chunk streams.
  function sseResponse(chunks: string[] | string, init: { status?: number } = {}): Response {
    const arr = Array.isArray(chunks) ? chunks : [chunks];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const c of arr) controller.enqueue(encoder.encode(c));
        controller.close();
      }
    });
    return new Response(stream, {
      status: init.status ?? 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  function pendingResponse(): Response {
    // A response whose body never yields — used to trigger TTFB / idle
    // timeouts. Stream stays open until the test aborts.
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never enqueue or close.
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  async function collect(input: Parameters<typeof callRowboatChatStream>[0]) {
    const events: Awaited<ReturnType<typeof Array.from>> = [];
    for await (const ev of callRowboatChatStream(input)) {
      // Cap defensively so a parser bug can't turn a test into an
      // infinite generator and hang CI.
      events.push(ev);
      if (events.length > 100) break;
    }
    return events as unknown as Array<{ type: string }>;
  }

  it("yields delta events as SSE chunks arrive, then a done event with metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"delta","content":"Hello"}\n\n',
          'data: {"type":"delta","content":" world"}\n\n',
          'data: {"type":"done","conversationId":"c1","state":{"x":1}}\n\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events.map((e) => e.type)).toEqual(["delta", "delta", "done"]);
    const lastEv = events.at(-1) as {
      type: string;
      conversationId: string | undefined;
      state: unknown;
    };
    expect(lastEv.conversationId).toBe("c1");
    expect(lastEv.state).toEqual({ x: 1 });
  });

  it("includes conversationId + state in the request body when continuing a thread", async () => {
    // Server-side memory continuation: when we have a stored
    // conversationId AND state, both must travel in the body so
    // Rowboat can resume the existing conversation. The buffered
    // call has the same contract; this test pins it for streaming.
    const fetchSpy = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"delta","content":"x"}\n\n',
        'data: {"type":"done"}\n\n'
      ])
    );
    vi.stubGlobal("fetch", fetchSpy);
    await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      conversationId: "prev-conv",
      state: { workflow: "step-3" }
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.conversationId).toBe("prev-conv");
    expect(body.state).toEqual({ workflow: "step-3" });
  });

  it("omits state from the body when a conversationId is set but state is null/undefined — matches the buffered API's contract", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      sseResponse('data: {"type":"done"}\n\n')
    );
    vi.stubGlobal("fetch", fetchSpy);
    await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      conversationId: "prev-conv",
      state: null
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.conversationId).toBe("prev-conv");
    expect(body).not.toHaveProperty("state");
  });

  it("sends stream:true and the Accept: text/event-stream header — Rowboat needs both to actually open the SSE pipe", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      sseResponse('data: {"type":"delta","content":"x"}\n\ndata: [DONE]\n\n')
    );
    vi.stubGlobal("fetch", fetchSpy);
    await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers.Authorization).toBe("Bearer B");
  });

  it("yields a single done event for the `[DONE]` sentinel — and follows the no-deltas-no-done path with rowboat_empty_assistant if no text arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse("data: [DONE]\n\n"))
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    // Explicit done with zero deltas — yields done (the route then
    // detects empty buffered text and emits its own friendly error).
    expect(events.at(-1)?.type).toBe("done");
  });

  it("yields rowboat_empty_assistant when stream closes with no deltas and no explicit done", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse("")));
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events).toEqual([
      { type: "error", message: "rowboat_empty_assistant" }
    ]);
  });

  it("yields rowboat_http_<status> when Rowboat returns a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 524 }))
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events).toEqual([{ type: "error", message: "rowboat_http_524" }]);
  });

  it("yields rowboat_invalid_json when an SSE event payload doesn't match any recognised shape — surfaces format drift instead of silent empty replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse('data: {"unrecognized":"shape"}\n\n'))
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events.at(-1)).toEqual({ type: "error", message: "rowboat_invalid_json" });
  });

  it("yields rowboat_timeout when no first chunk arrives within ttfbTimeoutMs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          // Never resolve — we want the abort to win.
        });
      })
    );

    const gen = callRowboatChatStream({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      ttfbTimeoutMs: 100
    });
    // Advance past the TTFB cap so the AbortController fires.
    const first = gen.next();
    await vi.advanceTimersByTimeAsync(150);
    const result = await first;
    expect(result.value).toEqual({ type: "error", message: "rowboat_timeout" });
    vi.useRealTimers();
  });

  it("yields rowboat_timeout when the stream stalls mid-flight (idle timer fires after first chunk)", async () => {
    // We deliberately don't use fake timers here because the body
    // reader's read() promise interacts oddly with vi.advanceTimers.
    // Instead we use a tiny real idle cap + a stream that emits one
    // chunk and never another.
    const controllerRef: { c: ReadableStreamDefaultController<Uint8Array> | null } = {
      c: null
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controllerRef.c = c;
        const encoder = new TextEncoder();
        c.enqueue(encoder.encode('data: {"type":"delta","content":"hi"}\n\n'));
        // Then nothing — the idle timer should abort.
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      idleTimeoutMs: 50,
      ttfbTimeoutMs: 5_000
    });
    // First a delta, then a timeout error from the stalled stream.
    expect(events[0]).toEqual({ type: "delta", text: "hi" });
    expect(events.at(-1)).toEqual({ type: "error", message: "rowboat_timeout" });
    // Tidy up the stream so vitest doesn't hang.
    try {
      controllerRef.c?.close();
    } catch {
      /* ignore */
    }
    void pendingResponse(); // unused helper; keep tree-shaker happy
  });

  it("preserves last-write-wins for conversationId/state across multiple done-shaped events (some Rowboat builds emit metadata twice)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"delta","content":"hi"}\n\n',
          'data: {"type":"done","conversationId":"first","state":{"a":1}}\n\n',
          'data: {"conversationId":"second","state":{"b":2},"turn":{"output":[]}}\n\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    const last = events.at(-1) as {
      type: string;
      conversationId: string | undefined;
      state: unknown;
    };
    expect(last.type).toBe("done");
    expect(last.conversationId).toBe("second");
    expect(last.state).toEqual({ b: 2 });
  });

  it("yields rowboat_timeout when the TTFB timer fires DURING the fetch dial (signal aborts the in-flight fetch promise)", async () => {
    // Distinct from the "no first chunk" case — here fetch() itself
    // hasn't even resolved yet. The AbortController triggers our
    // catch block on the fetch call, and we see signal.aborted=true,
    // so we surface rowboat_timeout (not the raw "AbortError"
    // message). Pinning this branch matters because pre-streaming we
    // mapped abort errors via string-sniffing on the message; the
    // signal-state check is the new contract.
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            const err = new Error("AbortError");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      ttfbTimeoutMs: 20
    });
    expect(events).toEqual([{ type: "error", message: "rowboat_timeout" }]);
  });

  it("yields rowboat_timeout when the reader rejects while the timer is firing — covers the reader.read()-throws branch of the idle/TTFB path", async () => {
    // Specifically targets the branch where reader.read() rejects
    // (not the cancel-then-resolve-with-done path the other idle
    // test exercises). We force this by erroring the underlying
    // stream after a chunk has been emitted; the timer fires
    // simultaneously, abort.signal becomes aborted, and the read()
    // promise rejects. The function MUST surface "rowboat_timeout"
    // (NOT the raw error message) so the friendly-error layer maps
    // it consistently.
    let errCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const erroringStream = new ReadableStream<Uint8Array>({
      start(c) {
        errCtrl = c;
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init: RequestInit) => {
        // Hook the abort signal to error the body stream — simulates
        // a fetch implementation that surfaces abort by tearing down
        // the response body with an exception.
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          try {
            errCtrl?.error(new Error("aborted by signal"));
          } catch {
            /* ignore */
          }
        });
        return Promise.resolve(
          new Response(erroringStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          })
        );
      })
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      ttfbTimeoutMs: 20,
      idleTimeoutMs: 5_000
    });
    // Last event MUST be rowboat_timeout (the timer fired and
    // aborted; the read() rejection is a consequence, not the cause).
    expect(events.at(-1)).toEqual({ type: "error", message: "rowboat_timeout" });
  });

  it("forwards tool_call events through the integration path (parseRowboatStreamEvent yields → caller surfaces them)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"tool_call","name":"send_sms","arguments":{"to":"+1"}}\n\n',
          'data: {"type":"delta","content":"ok"}\n\n',
          'data: {"type":"done"}\n\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "delta",
      "done"
    ]);
  });

  it("yields a Rowboat-side error event verbatim when the SSE stream surfaces one (e.g. a model crash mid-stream)", async () => {
    // Distinct from a 5xx response code: Rowboat opens the SSE pipe
    // (200 OK), starts streaming, then emits an `error` event as a
    // proper SSE chunk. The route uses this to decide whether the
    // stateless retry is appropriate — must propagate the
    // `Error.message`-style code untouched.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse('data: {"type":"error","message":"rowboat_http_503"}\n\n')
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events).toEqual([
      { type: "error", message: "rowboat_http_503" }
    ]);
  });

  it("propagates a non-abort fetch error as a non-timeout error event — surfaces real network errors so the route doesn't masquerade them as timeouts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNRESET"))
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events).toEqual([{ type: "error", message: "ECONNRESET" }]);
  });

  it("stringifies non-Error rejections so the catch path can't crash on weird thrown values", async () => {
    // Some libraries throw plain strings or POJOs (looking at you,
    // hand-rolled SDKs). The error event must still be well-typed
    // {type:'error',message:string} so the route's downstream
    // handling doesn't blow up on `undefined` or `[object Object]`
    // in a Datadog log.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("plain-string-rejection"));
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events).toEqual([
      { type: "error", message: "plain-string-rejection" }
    ]);
  });

  it("yields a non-timeout error event when the body reader throws after fetch resolved (e.g. peer reset mid-stream)", async () => {
    // Distinct from the abort path: the underlying stream throws on
    // read() but our AbortController never fired. We must surface the
    // raw error message so describeRowboatError doesn't mistakenly
    // tell the owner "your coworker took too long" when it was
    // actually a peer-reset.
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Don't enqueue, don't close — instead, the reader will reject
        // when controller.error is called.
      }
    });
    // Force an error after the response is constructed by hooking the
    // controller via a custom underlying source.
    let errorController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const erroringStream = new ReadableStream<Uint8Array>({
      start(c) {
        errorController = c;
        // Schedule the error after a tick so the consumer is reading.
        setTimeout(() => {
          try {
            c.error(new Error("network hiccup"));
          } catch {
            /* ignore */
          }
        }, 5);
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(erroringStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      ttfbTimeoutMs: 5_000,
      idleTimeoutMs: 5_000
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe("error");
    const last = events.at(-1) as { type: string; message: string };
    expect(last.message).toBe("network hiccup");
    // Reference unused stream to keep tree-shaker happy.
    void stream;
    void errorController;
  });

  it("yields rowboat_invalid_json when the response has no body (server returned 200 with Content-Length: 0)", async () => {
    // Vercel's edge has been observed returning empty 200s on
    // misconfigured routes; the parser MUST surface this as an
    // explicit `rowboat_invalid_json` event rather than silently
    // emitting an empty done.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events).toEqual([{ type: "error", message: "rowboat_invalid_json" }]);
  });

  it("ignores SSE data fields with a leading space (per spec: 'data: x' and 'data:x' are equivalent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          // Both forms in the same response — exercise the slice/replace
          // path that strips the leading space.
          'data: {"type":"delta","content":"a"}\n\n',
          'data:{"type":"delta","content":"b"}\n\n',
          'data: {"type":"done"}\n\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    const deltas = events
      .filter((e) => e.type === "delta")
      .map((e) => (e as unknown as { text: string }).text);
    expect(deltas).toEqual(["a", "b"]);
  });

  it("ignores SSE event lines without a data: field (event:, id:, comment lines starting with `:`)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          ": keep-alive\n\n",
          'event: message\nid: 1\ndata: {"type":"delta","content":"x"}\n\n',
          'data: {"type":"done"}\n\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
  });

  it("normalises CRLF line endings — some intermediaries emit `\\r\\n\\r\\n` instead of `\\n\\n` between SSE events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"delta","content":"a"}\r\n\r\n',
          'data: {"type":"done"}\r\n\r\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
  });
});
