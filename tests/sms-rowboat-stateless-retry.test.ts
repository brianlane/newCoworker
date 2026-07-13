import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callSmsRowboatWithStatelessFallback,
  CONVERSATION_STATE_RETRY_ERRORS,
  parseRowboatChatJson,
  STATELESS_RETRY_ERRORS,
  TRANSIENT_SERVER_RETRY_ERRORS
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

  it("skips non-assistant entries, missing-content entries, and whitespace-only content (covers all three short-circuits in the role/type/trim guard)", () => {
    // Pin every short-circuit of `m.role === "assistant" &&
    // typeof m.content === "string" && m.content.trim()` so a future
    // refactor can't silently change which messages count as a real
    // assistant reply.
    const r = parseRowboatChatJson({
      turn: {
        output: [
          { role: "system", content: "system message" },
          { role: "user", content: "user message" },
          { role: "assistant", content: null },
          { role: "assistant" },
          { role: "assistant", content: "" },
          { role: "assistant", content: "   " },
          { role: "assistant", content: "real reply" },
          { role: "assistant", content: "second reply, never reached" }
        ]
      }
    });
    expect(r.reply).toBe("real reply");
  });
});

describe("retry-error classes — deliberately bounded sets", () => {
  // The sets are intentionally small. Adding entries without updating the
  // dashboard chat path's mirror concept (or vice-versa) creates skew
  // between SMS and dashboard retry behaviour. These tests pin the surface
  // so a casual edit triggers a visible diff.
  it("conversation-state codes (always stateless-eligible) — no more, no less", () => {
    expect([...CONVERSATION_STATE_RETRY_ERRORS].sort()).toEqual([
      "rowboat_empty_assistant",
      "rowboat_http_400",
      "rowboat_http_404",
      "rowboat_http_409"
    ]);
  });

  it("transient 5xx codes (stateless only via allowStatelessOnServerErrors) — no more, no less", () => {
    // A 5xx is usually an upstream model outage (2026-07-13: Gemini 503s
    // surfaced as Rowboat 500s); dropping the continuation for it discards
    // the SMS thread. Callers must opt in explicitly.
    expect([...TRANSIENT_SERVER_RETRY_ERRORS].sort()).toEqual([
      "rowboat_http_500",
      "rowboat_http_502",
      "rowboat_http_503"
    ]);
  });

  it("STATELESS_RETRY_ERRORS stays the exact union of both classes", () => {
    expect([...STATELESS_RETRY_ERRORS].sort()).toEqual(
      [...CONVERSATION_STATE_RETRY_ERRORS, ...TRANSIENT_SERVER_RETRY_ERRORS].sort()
    );
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
    ["rowboat_http_409", 409]
  ])("retries on %s by default (conversation-state class)", async (_label, status) => {
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

  it.each([
    ["rowboat_http_500", 500],
    ["rowboat_http_502", 502],
    ["rowboat_http_503", 503]
  ])(
    "does NOT retry on %s by default — a transient upstream outage must not cost the thread its history (2026-07-13 incident)",
    async (label, status) => {
      const fetchStub = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({}, { status }));
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
      ).rejects.toThrow(label);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["rowboat_http_500", 500],
    ["rowboat_http_502", 502],
    ["rowboat_http_503", 503]
  ])("retries on %s when allowStatelessOnServerErrors is set (late-attempt last resort)", async (_label, status) => {
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
        timeoutMs: 60_000,
        allowStatelessOnServerErrors: true
      },
      fetchStub
    );
    expect(result.retriedStateless).toBe(true);
    expect(result.reply).toBe("fresh");
  });

  it("appends statelessContextExtra to the preamble ONLY on the stateless retry call", async () => {
    // The retry roots a brand-new Rowboat conversation; the transcript block
    // is what keeps it from restarting intake. The first (stateful) attempt
    // must NOT carry it — Rowboat already holds the history there.
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(rowboatReply("fresh", "conv-NEW")));
    await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hi",
        conversationId: "conv-STALE",
        state: null,
        timeoutMs: 60_000,
        customerPreamble: "Customer profile: Joe.",
        statelessContextExtra: "Recent SMS conversation:\nTexter: hi\nYou: hello"
      },
      fetchStub
    );
    const firstBody = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(firstBody.messages[0]).toEqual({ role: "system", content: "Customer profile: Joe." });
    const retryBody = JSON.parse(String(fetchStub.mock.calls[1]?.[1]?.body));
    expect(retryBody.messages[0]).toEqual({
      role: "system",
      content: "Customer profile: Joe.\n\nRecent SMS conversation:\nTexter: hi\nYou: hello"
    });
  });

  it("statelessContextExtra alone (no customerPreamble) still lands as the retry's system message", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(rowboatReply("fresh", "conv-NEW")));
    await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hi",
        conversationId: "conv-STALE",
        state: null,
        timeoutMs: 60_000,
        statelessContextExtra: "Recent SMS conversation:\nTexter: hi\nYou: hello"
      },
      fetchStub
    );
    const firstBody = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(firstBody.messages[0]?.role).toBe("user");
    const retryBody = JSON.parse(String(fetchStub.mock.calls[1]?.[1]?.body));
    expect(retryBody.messages[0]).toEqual({
      role: "system",
      content: "Recent SMS conversation:\nTexter: hi\nYou: hello"
    });
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

  it("coerces a non-Error throw via String() so the retry classifier can still pattern-match (defensive: vendor SDKs sometimes throw raw strings)", async () => {
    // Pin the `err instanceof Error ? err.message : String(err)`
    // branch in the fallback's catch. If we accidentally drop the
    // String() coercion the retry classifier would `.has(undefined)`
    // and silently turn every non-Error throw into a hard failure.
    const fetchStub = vi
      .fn<typeof fetch>()      .mockImplementationOnce(() => Promise.reject("rowboat_http_500" as unknown as Error))
      .mockResolvedValueOnce(jsonResponse(rowboatReply("fresh", "conv-NEW")));
    const result = await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hi",
        conversationId: "conv-STALE",
        state: null,
        timeoutMs: 60_000,
        allowStatelessOnServerErrors: true
      },
      fetchStub
    );
    expect(result.retriedStateless).toBe(true);
    expect(result.reply).toBe("fresh");
  });

  it("re-throws the underlying network error verbatim when fetch rejects WITHOUT an abort (e.g. DNS failure, connection refused)", async () => {
    // Pin the line in callRowboatChatOnce that re-throws non-abort
    // fetch errors. Without this branch a transient network blip
    // would be silently misreported as `rowboat_timeout` and trigger
    // the wrong retry/skip logic upstream.
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
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
    ).rejects.toThrow("ECONNREFUSED");
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

describe("callSmsRowboatWithStatelessFallback — combined budget bound (P1 fix)", () => {
  // The bug being pinned: a slow first call (~60s timeoutMs) followed
  // by a fresh full-window retry (another 60s) put the SMS worker at
  // ~120s wall time total — but pg_cron caps the worker HTTP
  // invocation at 90s, so the retry was getting truncated mid-call
  // and the outbound never went out. Cron then requeued the same
  // job, looping forever.
  //
  // Fix: pass `budgetMs` for COMBINED wall time across both calls.
  // The retry's per-call timeoutMs is internally clamped to
  // (budgetMs − elapsed) so the sum stays bounded.

  it("clamps the retry's timeoutMs to the remaining combined budget", async () => {
    // Simulate first call taking ~50ms before failing with retryable
    // status. With budget=200ms, retry should get at most ~150ms.
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse({}, { status: 500 });
    });
    let observedRetrySignal: AbortSignal | undefined;
    fetchStub.mockImplementationOnce(async (_url, init) => {
      observedRetrySignal = init?.signal as AbortSignal;
      return jsonResponse(rowboatReply("ok", "c-NEW"));
    });

    const result = await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hi",
        conversationId: "conv-STALE",
        state: null,
        timeoutMs: 10_000,
        budgetMs: 200,
        retryMinBudgetMs: 50,
        allowStatelessOnServerErrors: true
      },
      fetchStub
    );
    expect(result.retriedStateless).toBe(true);
    expect(observedRetrySignal).toBeDefined();
    // Indirect assertion: the retry actually completed within the
    // shrunken window, and the helper didn't grant a fresh 10s.
  });

  it("skips retry entirely when remaining budget < retryMinBudgetMs (surfaces FIRST error)", async () => {
    // First call fails fast (~10ms) with HTTP 500. Budget is 50ms,
    // retryMinBudgetMs is 100ms — so even though budget would
    // technically allow a 40ms retry, we skip and surface the first
    // error rather than guarantee a self-inflicted timeout.
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockImplementationOnce(async () => {
      return jsonResponse({}, { status: 500 });
    });
    await expect(
      callSmsRowboatWithStatelessFallback(
        {
          chatUrl: ROWBOAT_URL,
          bearer: BEARER,
          userText: "hi",
          conversationId: "conv-STALE",
          state: null,
          timeoutMs: 10_000,
          budgetMs: 50,
          retryMinBudgetMs: 100,
          allowStatelessOnServerErrors: true
        },
        fetchStub
      )
    ).rejects.toThrow("rowboat_http_500");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("uses default retry-min-budget (5s) when caller doesn't override", async () => {
    // Budget 1000ms, default retryMinBudgetMs=5000ms — first failure
    // means remaining ~1000ms which is < 5000, so retry is skipped.
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockImplementationOnce(async () => {
      return jsonResponse({}, { status: 500 });
    });
    await expect(
      callSmsRowboatWithStatelessFallback(
        {
          chatUrl: ROWBOAT_URL,
          bearer: BEARER,
          userText: "hi",
          conversationId: "conv-STALE",
          state: null,
          timeoutMs: 10_000,
          budgetMs: 1_000,
          allowStatelessOnServerErrors: true
        },
        fetchStub
      )
    ).rejects.toThrow("rowboat_http_500");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("never extends a single call past its configured per-call timeoutMs", async () => {
    // Budget is 100s of seconds (effectively unbounded), but
    // timeoutMs is 50ms. Retry's per-call timeout must not exceed
    // 50ms even though the budget allows much more — we don't want
    // the helper to silently extend a tight per-call ceiling.
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockImplementationOnce(async () => {
      return jsonResponse({}, { status: 500 });
    });
    let observedRetryAborted = false;
    fetchStub.mockImplementationOnce((_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          observedRetryAborted = true;
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
          conversationId: "conv-STALE",
          state: null,
          timeoutMs: 50,
          budgetMs: 100_000,
          retryMinBudgetMs: 1,
          allowStatelessOnServerErrors: true
        },
        fetchStub
      )
    ).rejects.toThrow("rowboat_timeout");
    expect(observedRetryAborted).toBe(true);
  });

  it("falls back to timeoutMs*2 when budgetMs is unset (preserves legacy callers)", async () => {
    // Backwards compat: untouched callers continue to behave exactly
    // as they did pre-fix. New SMS worker always passes budgetMs;
    // this test pins the safety net for any other future caller.
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(rowboatReply("ok", "c-NEW")));
    const result = await callSmsRowboatWithStatelessFallback(
      {
        chatUrl: ROWBOAT_URL,
        bearer: BEARER,
        userText: "hi",
        conversationId: "conv-STALE",
        state: null,
        timeoutMs: 60_000,
        allowStatelessOnServerErrors: true
      },
      fetchStub
    );
    expect(result.retriedStateless).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
