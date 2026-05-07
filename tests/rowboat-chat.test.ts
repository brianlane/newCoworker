import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assistantFromRowboat,
  buildRowboatChatUrl,
  callRowboatChat,
  callRowboatChatStream,
  DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE,
  describeRowboatError,
  parseRowboatChatJson,
  parseRowboatStreamEvent,
  ROWBOAT_STREAM_NOOP
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

  // Helper to narrow a parse result to a typed event for `.type`/
  // `.state` accesses. The parser now returns
  // `RowboatStreamEvent | "noop" | null` after the Codex P1 / Cursor
  // Bugbot HIGH fix on PR #76, so `ev?.type` no longer typechecks
  // when `ev` could be the "noop" sentinel. These tests always feed
  // payloads that produce typed events, so narrowing is purely for
  // TS — the runtime assertion below makes the regression visible if
  // a future parser change starts emitting noop for inputs we expect
  // to be typed events.
  function asEvent(r: ReturnType<typeof parseRowboatStreamEvent>) {
    expect(r).not.toBe(ROWBOAT_STREAM_NOOP);
    expect(r).not.toBeNull();
    return r as Exclude<typeof r, "noop" | null>;
  }

  it("returns a `done` event for the literal `[DONE]` SSE sentinel", () => {
    const ev = asEvent(parseRowboatStreamEvent("[DONE]"));
    expect(ev.type).toBe("done");
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

  it("returns ROWBOAT_STREAM_NOOP for OpenAI role-only and finish_reason keep-alives — caller skips them so the very first OpenAI chunk doesn't kill the whole stream (Codex P1 / Cursor Bugbot HIGH on PR #76: pre-fix these returned null, which the loop treated as fatal rowboat_invalid_json)", () => {
    expect(parseRowboatStreamEvent('{"choices":[{"delta":{"role":"assistant"}}]}')).toBe(
      ROWBOAT_STREAM_NOOP
    );
    expect(parseRowboatStreamEvent('{"choices":[{"finish_reason":"stop","delta":{}}]}')).toBe(
      ROWBOAT_STREAM_NOOP
    );
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
    const explicitNull = asEvent(
      parseRowboatStreamEvent('{"type":"done","conversationId":"c","state":null}')
    );
    expect(explicitNull.type).toBe("done");
    if (explicitNull.type === "done") {
      expect(explicitNull.hasStateKey).toBe(true);
      expect(explicitNull.state).toBeNull();
    }

    const missing = asEvent(
      parseRowboatStreamEvent('{"type":"done","conversationId":"c"}')
    );
    expect(missing.type).toBe("done");
    if (missing.type === "done") expect(missing.hasStateKey).toBe(false);
  });

  it("parses error events", () => {
    const ev = parseRowboatStreamEvent(
      '{"type":"error","message":"rowboat_http_500"}'
    );
    expect(ev).toEqual({ type: "error", message: "rowboat_http_500" });
  });

  it("treats a final Rowboat-shaped JSON `{turn:{output:[...]}}` as a done event with metadata", () => {
    const ev = asEvent(
      parseRowboatStreamEvent(
        '{"conversationId":"c","state":{"x":1},"turn":{"output":[]}}'
      )
    );
    expect(ev.type).toBe("done");
    if (ev.type === "done") expect(ev.conversationId).toBe("c");
  });

  it("hypothesis-3 path: a final JSON with conversationId but NO state key omits state from the done event (preserves the buffered API's hasStateKey=false semantics)", async () => {
    // Pinned for the route-side semantics: `hasStateKey=false` means
    // "Rowboat didn't echo state, don't overwrite our stored copy"
    // (the buffered code's contract). The streaming parser must
    // mirror this exactly.
    const ev = asEvent(
      parseRowboatStreamEvent('{"conversationId":"c","turn":{"output":[]}}')
    );
    expect(ev.type).toBe("done");
    if (ev.type === "done") {
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

  it("returns ROWBOAT_STREAM_NOOP for a delta-typed event with no {content, text, delta} — be liberal in what we accept rather than tearing down the whole stream over a single malformed chunk (the next chunk usually carries real content)", () => {
    // Rowboat-native shape says this IS a delta event; we just don't
    // have content to render. Skipping is safer than killing — a brief
    // upstream hiccup that emits one bad chunk would otherwise lose
    // the entire reply. The idle timer still resets on the chunk
    // arrival, and if the upstream is genuinely broken the next event
    // will hit the unrecognised-shape path and surface invalid_json
    // anyway.
    expect(parseRowboatStreamEvent('{"type":"delta"}')).toBe(ROWBOAT_STREAM_NOOP);
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

  it("OpenAI hypothesis-1 path: tolerates `choices[0]` being null without crashing — returns ROWBOAT_STREAM_NOOP so the stream loop skips the keep-alive without yelling invalid_json", () => {
    // Some OpenAI-compat servers emit a chunk with `choices: [null]`
    // as a final keep-alive. The parser MUST treat this as a no-op
    // for the caller to skip rather than throwing on a null property
    // access OR returning hard-null (which the loop would surface as
    // rowboat_invalid_json — see Codex P1 / Cursor Bugbot HIGH on PR #76).
    expect(parseRowboatStreamEvent('{"choices":[null]}')).toBe(ROWBOAT_STREAM_NOOP);
  });

  it("hypothesis-3 path: a final JSON with state but NO conversationId still yields done with conversationId=undefined and state preserved", async () => {
    // Rowboat is observed (in some builds) emitting a final JSON that
    // carries `state` but omits `conversationId` — happens when the
    // server already returned a fresh conversation id earlier as a
    // separate meta event. The parser must still extract the state
    // metadata in that case (the route relies on hasStateKey to know
    // whether to overwrite the stored continuation).
    const ev = asEvent(parseRowboatStreamEvent('{"state":null,"turn":{"output":[]}}'));
    expect(ev.type).toBe("done");
    if (ev.type === "done") {
      expect(ev.conversationId).toBeUndefined();
      expect(ev.hasStateKey).toBe(true);
      expect(ev.state).toBeNull();
    }
  });

  it("returns null for unrecognised payload shapes — the stream loop surfaces this as rowboat_invalid_json instead of silently dropping content", () => {
    expect(parseRowboatStreamEvent('{"weird":"shape"}')).toBeNull();
  });

  it("returns ROWBOAT_STREAM_NOOP for empty / whitespace input — these are SSE heartbeat lines and would kill the stream if treated as invalid_json", () => {
    expect(parseRowboatStreamEvent("")).toBe(ROWBOAT_STREAM_NOOP);
    expect(parseRowboatStreamEvent("   ")).toBe(ROWBOAT_STREAM_NOOP);
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

  it("yields rowboat_empty_assistant for an explicit `[DONE]` sentinel with zero deltas — Cursor Bugbot Medium regression test from PR #76 commit d6a3145: pre-fix this case yielded a normal `done`, which let the route exit `kind:\"done\"` and skip the stateless retry that would have recovered from a stale conversation continuation. A stream with no delta events IS empty regardless of whether it terminated with [DONE] or a connection drop, and rowboat_empty_assistant is the entry point into STATELESS_RETRY_ERRORS.", async () => {
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
    expect(events).toEqual([
      { type: "error", message: "rowboat_empty_assistant" }
    ]);
  });

  it("yields rowboat_empty_assistant for an explicit Rowboat-native `{type:\"done\"}` event with zero deltas — same fix as the [DONE] case but exercises the Rowboat-native event shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse('data: {"type":"done","conversationId":"c1"}\n\n')
      )
    );
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

  it("cancels the body reader when the TTFB timer fires AFTER fetch resolved but before the first body byte — Cursor Bugbot Medium regression test from PR #76 commit abb057f: cold-tenant Ollama loads model in 25+ seconds, headers arrive fast, reader.read() blocks; pre-fix the initial TTFB callback only called abort.abort() and the generator hung", async () => {
    // Reproduce the cold-tenant cold-model timing exactly:
    //   1. fetch() resolves quickly with a 200 + body stream.
    //   2. Reader is constructed.
    //   3. Reader.read() blocks (the body stream never enqueues a byte).
    //   4. TTFB timer fires.
    //   5. Generator MUST yield rowboat_timeout (not hang).
    let readerCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        readerCancelled = true;
      },
      // Never enqueue. Without reader.cancel() being called from the
      // TTFB timer, reader.read() would block indefinitely.
      start() {}
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
      ttfbTimeoutMs: 50,
      idleTimeoutMs: 5_000
    });
    // The generator must terminate on the TTFB timeout, not hang.
    expect(events).toEqual([{ type: "error", message: "rowboat_timeout" }]);
    // And the reader was actually cancelled — pre-fix only abort.abort()
    // ran, which doesn't propagate to the body stream once fetch
    // resolved (lines 617-622 of chat.ts already document this).
    expect(readerCancelled).toBe(true);
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

  it("skips OpenAI keep-alive chunks (role-only first chunk + finish_reason terminator) and still emits the real delta — Codex P1 / Cursor Bugbot HIGH regression test from PR #76: pre-fix the role-only chunk caused rowboat_invalid_json before any token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          // OpenAI's standard first chunk: role only, no content. Pre-fix
          // the loop killed the whole stream right here.
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          // Real content.
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          // OpenAI's standard last chunk: finish_reason, no content.
          'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
          // Final state.
          'data: {"type":"done","conversationId":"c1","state":{"k":1}}\n\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }]
    });
    // Only the real delta and the done event should surface; both
    // keep-alives must be silently skipped.
    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      {
        type: "done",
        conversationId: "c1",
        state: { k: 1 },
        hasStateKey: true
      }
    ]);
  });

  it("does NOT kill the stream on a malformed Rowboat-native delta (no content/text/delta) — treats it as a noop and continues so a single bad chunk doesn't lose the entire reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"delta"}\n\n',
          'data: {"type":"delta","content":"Hello"}\n\n',
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
    expect(events).toEqual([
      { type: "delta", text: "Hello" },
      {
        type: "done",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      }
    ]);
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

  it("forwards an external AbortSignal into fetch and tears down the upstream stream when the caller aborts mid-generation — Codex P2 / Cursor Bugbot Medium regression test from PR #76: pre-fix the route's upstreamAbort was disconnected, so client disconnects left the per-tenant Ollama generating tokens nobody read", async () => {
    let receivedSignal: AbortSignal | null = null;
    let readerCancelled = false;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      receivedSignal = (init.signal as AbortSignal) ?? null;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          readerCancelled = true;
        },
        // Never enqueue, never close. The generator will block on
        // reader.read() until the external abort fires.
        start() {}
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const externalAbort = new AbortController();
    const gen = callRowboatChatStream({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      ttfbTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      signal: externalAbort.signal
    });

    // Pump the first iteration on a microtask, then trigger the
    // external abort — the generator should yield rowboat_timeout
    // (the abort path goes through the same AbortController as the
    // timer path, so the message is uniform — describeRowboatError
    // already maps rowboat_timeout to a friendly "took too long").
    const next = gen.next();
    // Yield to the event loop so the fetch() promise resolves and the
    // reader is constructed before we abort.
    await Promise.resolve();
    await Promise.resolve();
    externalAbort.abort();
    const first = await next;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "error", message: "rowboat_timeout" });

    // The upstream signal was actually wired to the fetch (so an
    // intermediary that respects request cancellation can stop too),
    // AND the body reader was cancelled (so the per-tenant Rowboat
    // sees its TCP socket close instead of streaming into the void).
    expect(receivedSignal).not.toBeNull();
    expect(readerCancelled).toBe(true);
  });

  it("aborts the in-flight fetch when the external signal fires BEFORE the response arrives — exercises the initial pre-reader cancelUpstream closure (the post-reader upgrade is covered separately above)", async () => {
    // The pre-reader path matters because Cloudflare/llm-router
    // sometimes takes 5-10s to start streaming on cold tenants. If
    // the owner navigates away during that pre-stream window we MUST
    // abort the fetch (otherwise the per-tenant Ollama still gets
    // the prompt and starts generating).
    // Refs (not `let` bindings) so TS doesn't narrow these to their
    // initial null type after the callback assignment — a long-running
    // quirk with async writes from inside Promise executors.
    const signalRef: { current: AbortSignal | null } = { current: null };
    const resolveFetchRef: { current: ((r: Response) => void) | null } = {
      current: null
    };
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          signalRef.current = (init.signal as AbortSignal) ?? null;
          resolveFetchRef.current = resolve;
          // Bridge the abort signal to the fetch promise: a real
          // fetch implementation rejects with AbortError when its
          // signal aborts. Without this the test would hang.
          (init.signal as AbortSignal | undefined)?.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              (err as Error & { name: string }).name = "AbortError";
              reject(err);
            },
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const externalAbort = new AbortController();
    const gen = callRowboatChatStream({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      ttfbTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      signal: externalAbort.signal
    });
    const next = gen.next();
    // Yield once so the fetch promise is set up but not resolved.
    await Promise.resolve();
    externalAbort.abort();
    const first = await next;
    expect(first.value).toEqual({ type: "error", message: "rowboat_timeout" });
    // Sanity: the abort signal was actually plumbed into fetch (so a
    // compliant fetch impl tears down the connection too, not just
    // the local generator).
    expect(signalRef.current?.aborted).toBe(true);
    // We never got a response.
    expect(resolveFetchRef.current).not.toBeNull();
  });

  it("removes the external-signal listener on the !res.ok early-return path — non-2xx exits before the body reader exists, so the cleanup must happen at the early return (otherwise long-lived caller signals leak listeners across every failed turn)", async () => {
    const calls: Array<{ op: "add" | "remove"; type: string }> = [];
    const fakeSignal: AbortSignal = {
      aborted: false,
      reason: undefined,
      onabort: null,
      throwIfAborted: () => {},
      addEventListener: (type: string) => {
        calls.push({ op: "add", type });
      },
      removeEventListener: (type: string) => {
        calls.push({ op: "remove", type });
      },
      dispatchEvent: () => true
    } as unknown as AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 }))
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      signal: fakeSignal
    });
    expect(events).toEqual([{ type: "error", message: "rowboat_http_500" }]);
    const adds = calls.filter((c) => c.op === "add" && c.type === "abort").length;
    const removes = calls.filter((c) => c.op === "remove" && c.type === "abort").length;
    expect(adds).toBe(1);
    expect(removes).toBe(1);
  });

  it("removes the external-signal listener on the !res.body early-return path — empty 200 response also exits pre-reader and must not leak listeners", async () => {
    const calls: Array<{ op: "add" | "remove"; type: string }> = [];
    const fakeSignal: AbortSignal = {
      aborted: false,
      reason: undefined,
      onabort: null,
      throwIfAborted: () => {},
      addEventListener: (type: string) => {
        calls.push({ op: "add", type });
      },
      removeEventListener: (type: string) => {
        calls.push({ op: "remove", type });
      },
      dispatchEvent: () => true
    } as unknown as AbortSignal;
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
      messages: [{ role: "user", content: "hi" }],
      signal: fakeSignal
    });
    expect(events).toEqual([{ type: "error", message: "rowboat_invalid_json" }]);
    const adds = calls.filter((c) => c.op === "add" && c.type === "abort").length;
    const removes = calls.filter((c) => c.op === "remove" && c.type === "abort").length;
    expect(adds).toBe(1);
    expect(removes).toBe(1);
  });

  it("aborts synchronously when the caller passes an already-aborted signal — fetch is called with an already-aborted signal so any compliant intermediary rejects immediately, surfacing as rowboat_timeout", async () => {
    // Defensive corner: a parent that re-uses an AbortController
    // across many turns might pass it after a prior turn already
    // aborted it. The internal abort fires synchronously, so the
    // outgoing fetch carries an already-aborted signal — a compliant
    // fetch implementation rejects with AbortError immediately,
    // landing in the `catch` block and surfacing the uniform
    // rowboat_timeout error code (no Rowboat tokens consumed).
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sig = init.signal as AbortSignal | undefined;
      if (sig?.aborted) {
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        throw err;
      }
      /* c8 ignore next 5 -- defensive: this branch is unreachable in
         this test (we only call fetch with an already-aborted signal),
         but the explicit fallback documents the contract for a future
         maintainer reading the mock. */
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    ac.abort();
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal
    });
    expect(events).toEqual([{ type: "error", message: "rowboat_timeout" }]);
  });

  it("removes the external-signal abort listener after the stream completes — long-lived caller signals (parent component AbortController held across many turns) must not accumulate listeners", async () => {
    // We can't easily count listeners on a real AbortSignal, so use a
    // minimal stand-in that records add/remove calls. The contract:
    // for every addEventListener we make, there's a matching
    // removeEventListener (either via `once: true` firing OR our
    // explicit cleanup in finally / early-return paths).
    const calls: Array<{ op: "add" | "remove"; type: string }> = [];
    const fakeSignal: AbortSignal = {
      aborted: false,
      reason: undefined,
      onabort: null,
      throwIfAborted: () => {},
      addEventListener: (type: string) => {
        calls.push({ op: "add", type });
      },
      removeEventListener: (type: string) => {
        calls.push({ op: "remove", type });
      },
      dispatchEvent: () => true
    } as unknown as AbortSignal;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"delta","content":"hi"}\n\n',
          'data: {"type":"done"}\n\n'
        ])
      )
    );
    const events = await collect({
      businessId: BIZ,
      projectId: PROJ,
      bearer: "B",
      messages: [{ role: "user", content: "hi" }],
      signal: fakeSignal
    });
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
    const adds = calls.filter((c) => c.op === "add" && c.type === "abort").length;
    const removes = calls.filter((c) => c.op === "remove" && c.type === "abort").length;
    expect(adds).toBe(1);
    expect(removes).toBe(1);
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
