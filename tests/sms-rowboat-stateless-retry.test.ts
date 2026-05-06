import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callSmsRowboatWithStatelessFallback,
  parseRowboatChatJson,
  STATELESS_RETRY_ERRORS
} from "../supabase/functions/_shared/sms_rowboat";

const ROWBOAT_URL = "https://biz.example.test/api/v1/proj/chat";
const BEARER = "tok";

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json" }
  });
}

function rowboatReply(reply: string, conversationId?: string, state?: unknown): unknown {
  const body: Record<string, unknown> = {
    turn: { output: [{ role: "assistant", content: reply }] }
  };
  if (conversationId !== undefined) body.conversationId = conversationId;
  if (state !== undefined) body.state = state;
  return body;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRowboatChatJson", () => {
  it("extracts the first non-empty assistant message", () => {
    const r = parseRowboatChatJson(rowboatReply("hello there", "conv-1"));
    expect(r.reply).toBe("hello there");
    expect(r.conversationId).toBe("conv-1");
    expect(r.hasStateKey).toBe(false);
    expect(r.state).toBeUndefined();
  });

  it("distinguishes state present-but-null from state-omitted (hasStateKey)", () => {
    const present = parseRowboatChatJson({
      ...((rowboatReply("hi", "c") as object) ?? {}),
      state: null
    });
    expect(present.hasStateKey).toBe(true);
    expect(present.state).toBeNull();

    const omitted = parseRowboatChatJson(rowboatReply("hi", "c"));
    expect(omitted.hasStateKey).toBe(false);
  });

  it("returns empty reply for malformed payloads (caller surfaces rowboat_empty_assistant)", () => {
    expect(parseRowboatChatJson({}).reply).toBe("");
    expect(parseRowboatChatJson({ turn: { output: [] } }).reply).toBe("");
  });
});

describe("STATELESS_RETRY_ERRORS — deliberately bounded set", () => {
  // The set is intentionally small. Adding entries here without
  // updating the dashboard chat path's mirror list (or vice-versa)
  // creates skew between SMS and dashboard retry behaviour. This test
  // pins the surface so a casual edit triggers a visible diff.
  it("contains exactly the dashboard-chat-mirrored codes — no more, no less", () => {
    expect([...STATELESS_RETRY_ERRORS].sort()).toEqual([
      "rowboat_empty_assistant",
      "rowboat_http_400",
      "rowboat_http_404",
      "rowboat_http_409",
      "rowboat_http_500",
      "rowboat_http_502",
      "rowboat_http_503"
    ]);
  });

  it("EXCLUDES rowboat_timeout — retrying a slow VPS doubles load without diagnostic value", () => {
    expect(STATELESS_RETRY_ERRORS.has("rowboat_timeout")).toBe(false);
  });

  it("EXCLUDES rowboat_http_401/403 — auth is global; same bearer fails identically", () => {
    expect(STATELESS_RETRY_ERRORS.has("rowboat_http_401")).toBe(false);
    expect(STATELESS_RETRY_ERRORS.has("rowboat_http_403")).toBe(false);
  });
});

describe("callSmsRowboatWithStatelessFallback — happy path", () => {
  it("succeeds on the first call and does NOT retry", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(rowboatReply("hi back", "conv-1")));
    const result = await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hello",
        conversationId: "conv-1",
        state: { foo: "bar" },
        timeoutMs: 60_000
      },
      fetchStub
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("hi back");
    expect(result.retriedStateless).toBe(false);
    const firstCall = fetchStub.mock.calls[0];
    const body = JSON.parse(String(firstCall?.[1]?.body));
    expect(body.conversationId).toBe("conv-1");
    expect(body.state).toEqual({ foo: "bar" });
    expect(body.messages).toEqual([{ role: "user", content: "[SMS] hello" }]);
  });

  it("includes a system preamble when customerPreamble is supplied (Phase 3 hook)", async () => {
    // Phase 3 of the cross-channel memory plan injects per-customer
    // context. The helper passes it through as a system message; this
    // is the wire-level contract that test pins.
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(rowboatReply("hi back", "conv-1")));
    await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hello",
        conversationId: null,
        state: null,
        timeoutMs: 60_000,
        customerPreamble: "Customer Joe is a repeat buyer; last close: garage door spring."
      },
      fetchStub
    );
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([
      {
        role: "system",
        content: "Customer Joe is a repeat buyer; last close: garage door spring."
      },
      { role: "user", content: "[SMS] hello" }
    ]);
  });
});

describe("callSmsRowboatWithStatelessFallback — stateless retry on stale continuation", () => {
  it("retries WITHOUT conversationId/state on rowboat_http_400 and reports retriedStateless=true", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "stale" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse(rowboatReply("fresh reply", "conv-NEW")));
    const result = await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hello",
        conversationId: "conv-STALE",
        state: { foo: "bar" },
        timeoutMs: 60_000
      },
      fetchStub
    );
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("fresh reply");
    expect(result.conversationId).toBe("conv-NEW");
    expect(result.retriedStateless).toBe(true);

    const retryBody = JSON.parse(String(fetchStub.mock.calls[1]?.[1]?.body));
    expect(retryBody.conversationId).toBeUndefined();
    expect(retryBody.state).toBeUndefined();
  });

  it.each([
    ["rowboat_http_404", 404],
    ["rowboat_http_409", 409],
    ["rowboat_http_500", 500],
    ["rowboat_http_502", 502],
    ["rowboat_http_503", 503]
  ])("retries on %s (the full STATELESS_RETRY_ERRORS HTTP set)", async (_label, status) => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status }))
      .mockResolvedValueOnce(jsonResponse(rowboatReply("fresh", "conv-NEW")));
    const result = await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hi",
        conversationId: "conv-STALE",
        state: null,
        timeoutMs: 60_000
      },
      fetchStub
    );
    expect(result.retriedStateless).toBe(true);
    expect(result.reply).toBe("fresh");
  });

  it("retries on rowboat_empty_assistant (HTTP 200 but no assistant message)", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ turn: { output: [] } }))
      .mockResolvedValueOnce(jsonResponse(rowboatReply("fresh", "conv-NEW")));
    const result = await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hi",
        conversationId: "conv-STALE",
        state: null,
        timeoutMs: 60_000
      },
      fetchStub
    );
    expect(result.retriedStateless).toBe(true);
    expect(result.reply).toBe("fresh");
  });

  it("does NOT retry when there was no continuation to drop — nothing for a stateless retry to undo", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 400 }));
    await expect(
      callSmsRowboatWithStatelessFallback(
        {
          chatUrl: ROWBOAT_URL,
          bearer: BEARER,
          userText: "hi",
          conversationId: null,
          state: null,
          timeoutMs: 60_000
        },
        fetchStub
      )
    ).rejects.toThrow("rowboat_http_400");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on rowboat_timeout — slow VPS won't suddenly become fast", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    await expect(
      callSmsRowboatWithStatelessFallback(
        {
          chatUrl: ROWBOAT_URL,
          bearer: BEARER,
          userText: "hi",
          conversationId: "conv-1",
          state: null,
          timeoutMs: 50
        },
        fetchStub
      )
    ).rejects.toThrow("rowboat_timeout");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on rowboat_http_401 — auth failures aren't conversation-state-related", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }));
    await expect(
      callSmsRowboatWithStatelessFallback(
        {
          chatUrl: ROWBOAT_URL,
          bearer: BEARER,
          userText: "hi",
          conversationId: "conv-1",
          state: null,
          timeoutMs: 60_000
        },
        fetchStub
      )
    ).rejects.toThrow("rowboat_http_401");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("when retry ALSO fails, surfaces the retry's error (more recent diagnostic) — not the first call's", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }));
    await expect(
      callSmsRowboatWithStatelessFallback(
        {
          chatUrl: ROWBOAT_URL,
          bearer: BEARER,
          userText: "hi",
          conversationId: "conv-STALE",
          state: null,
          timeoutMs: 60_000
        },
        fetchStub
      )
    ).rejects.toThrow("rowboat_http_503");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
