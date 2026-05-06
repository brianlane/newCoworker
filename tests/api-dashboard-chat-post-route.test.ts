import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn()
}));

vi.mock("@/lib/db/configs", () => ({
  getBusinessConfig: vi.fn()
}));

vi.mock("@/lib/db/dashboard-chat", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/dashboard-chat")>(
    "@/lib/db/dashboard-chat"
  );
  return {
    ...actual,
    appendMessage: vi.fn(),
    deactivateActiveThread: vi.fn(),
    getActiveThread: vi.fn(),
    getOrCreateActiveThread: vi.fn(),
    getThreadById: vi.fn(),
    listMessages: vi.fn(),
    reactivateThread: vi.fn(),
    touchChatActivity: vi.fn(),
    updateThreadConversation: vi.fn()
  };
});

vi.mock("@/lib/rowboat/chat", () => ({
  callRowboatChat: vi.fn(),
  describeRowboatError: (err: unknown) =>
    err instanceof Error ? err.message : "rowboat error"
}));

vi.mock("@/lib/dashboard-chat/summarizer", () => ({
  shouldSummarize: vi.fn(),
  summarizeThreadAndLog: vi.fn()
}));

const supabaseFlagsStub = {
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn()
};
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseFlagsStub)
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { POST } from "@/app/api/dashboard/chat/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getBusinessConfig } from "@/lib/db/configs";
import {
  appendMessage,
  getOrCreateActiveThread,
  getThreadById,
  listMessages,
  reactivateThread,
  touchChatActivity,
  updateThreadConversation
} from "@/lib/db/dashboard-chat";
import { callRowboatChat } from "@/lib/rowboat/chat";
import {
  shouldSummarize,
  summarizeThreadAndLog
} from "@/lib/dashboard-chat/summarizer";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OTHER_BIZ = "22222222-2222-4222-8222-222222222222";
const ACTIVE_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const ARCHIVED_THREAD_ID = "44444444-4444-4444-8444-444444444444";

const ACTIVE_THREAD = {
  id: ACTIVE_THREAD_ID,
  business_id: BIZ,
  rowboat_conversation_id: "rb-conv",
  rowboat_state: { foo: 1 },
  title: "active",
  is_active: true,
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z",
  summary_md: null,
  summary_message_count: 0
};

const ARCHIVED_THREAD = {
  ...ACTIVE_THREAD,
  id: ARCHIVED_THREAD_ID,
  is_active: false,
  title: "archived"
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "owner@example.com",
    isAdmin: false
  } as never);
  vi.mocked(requireOwner).mockResolvedValue(undefined as never);
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 30,
    remaining: 29,
    reset: 0
  });

  // Business flags: not paused, customer channels enabled.
  supabaseFlagsStub.from.mockReturnValue(supabaseFlagsStub);
  supabaseFlagsStub.select.mockReturnValue(supabaseFlagsStub);
  supabaseFlagsStub.eq.mockReturnValue(supabaseFlagsStub);
  supabaseFlagsStub.maybeSingle.mockResolvedValue({
    data: {
      id: BIZ,
      is_paused: false,
      customer_channels_enabled: true
    },
    error: null
  });

  vi.mocked(getBusinessConfig).mockResolvedValue({
    rowboat_project_id: "proj-1"
  } as never);

  process.env.ROWBOAT_VPS_CHAT_BEARER = "bearer-xyz";

  vi.mocked(getOrCreateActiveThread).mockResolvedValue(ACTIVE_THREAD as never);
  vi.mocked(getThreadById).mockResolvedValue(ARCHIVED_THREAD as never);
  vi.mocked(reactivateThread).mockResolvedValue(undefined as never);
  vi.mocked(listMessages).mockResolvedValue([] as never);
  vi.mocked(callRowboatChat).mockResolvedValue({
    reply: "hi back",
    conversationId: "rb-conv-2",
    state: { bar: 2 },
    hasStateKey: true
  } as never);
  vi.mocked(appendMessage).mockResolvedValue(undefined as never);
  vi.mocked(touchChatActivity).mockResolvedValue(undefined as never);
  vi.mocked(updateThreadConversation).mockResolvedValue(undefined as never);
  vi.mocked(shouldSummarize).mockReturnValue(false);
  vi.mocked(summarizeThreadAndLog).mockResolvedValue(undefined as never);
});

afterEach(() => {
  delete process.env.ROWBOAT_VPS_CHAT_BEARER;
  delete process.env.ROWBOAT_GATEWAY_TOKEN;
});

describe("POST /api/dashboard/chat — legacy path (no threadId)", () => {
  it("uses getOrCreateActiveThread and never touches reactivate when caller omits threadId", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    expect(getOrCreateActiveThread).toHaveBeenCalledWith(BIZ, "hi");
    expect(getThreadById).not.toHaveBeenCalled();
    expect(reactivateThread).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/chat — threadId path (continue any thread)", () => {
  it("reactivates an archived thread and uses it as the append target — ChatGPT/Claude/Gemini-style continuation", async () => {
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: ARCHIVED_THREAD_ID, message: "continue" })
    );
    expect(res.status).toBe(200);
    expect(getThreadById).toHaveBeenCalledWith(ARCHIVED_THREAD_ID);
    expect(reactivateThread).toHaveBeenCalledWith(BIZ, ARCHIVED_THREAD_ID);
    // Must NOT mint a new thread when caller targeted a specific one.
    expect(getOrCreateActiveThread).not.toHaveBeenCalled();
    // Append goes to the resolved (archived-then-reactivated) thread.
    const appendCalls = vi.mocked(appendMessage).mock.calls;
    expect(appendCalls[0][0]).toBe(ARCHIVED_THREAD_ID);
    expect(appendCalls[1][0]).toBe(ARCHIVED_THREAD_ID);
  });

  it("skips reactivation when the targeted thread is already active (idempotent on repeat sends)", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce(ACTIVE_THREAD as never);
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: ACTIVE_THREAD_ID, message: "continue" })
    );
    expect(res.status).toBe(200);
    expect(reactivateThread).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the thread doesn't exist (caller-supplied UUID is bogus)", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce(null as never);
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: ARCHIVED_THREAD_ID, message: "x" })
    );
    expect(res.status).toBe(404);
    // No reactivate, no append — we never touched a real thread.
    expect(reactivateThread).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("rejects with 404 (NOT 403) when the thread belongs to another tenant — anti-IDOR + denies existence side-channel", async () => {
    // Thread exists, but business_id doesn't match the body — owner of
    // BIZ is trying to reactivate another tenant's thread. Same status
    // as missing so the caller can't probe for existence.
    vi.mocked(getThreadById).mockResolvedValueOnce({
      ...ARCHIVED_THREAD,
      business_id: OTHER_BIZ
    } as never);
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: ARCHIVED_THREAD_ID, message: "steal" })
    );
    expect(res.status).toBe(404);
    expect(reactivateThread).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("rejects malformed threadId at the schema layer (UUID validation) before any DB read", async () => {
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: "not-a-uuid", message: "x" })
    );
    expect(res.status).toBe(400);
    expect(getThreadById).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/chat — summary preamble", () => {
  it("prepends summary_md as a system message when present", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      summary_md: "earlier: discussed pricing tiers"
    } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "and now?" }));
    const sent = vi.mocked(callRowboatChat).mock.calls[0][0].messages;
    // System preamble must be first so the model anchors on it before
    // the recent-turn tail and the new user message.
    expect(sent[0]).toEqual({
      role: "system",
      content: "Conversation summary so far:\n\nearlier: discussed pricing tiers"
    });
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "and now?" });
  });

  it("does NOT prepend a system message when summary_md is null/empty/whitespace", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      summary_md: "   "
    } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const sent = vi.mocked(callRowboatChat).mock.calls[0][0].messages;
    expect(sent[0].role).not.toBe("system");
  });
});

describe("POST /api/dashboard/chat — Rowboat input contract (no plain assistant replay)", () => {
  // Rowboat's HTTP /chat validator rejects plain
  //   { role: "assistant", content: string }
  // entries (it expects agent/tool-shaped rows produced by Rowboat
  // itself). The integration spec is canonical:
  //   tests/integration/kvm-rowboat/rowboat-chat.ts:215
  //   "Each leg sends only the new user message; do not replay
  //    `{ role: 'assistant', content }` — upstream Zod expects
  //    agent/tool-shaped assistant rows, not plain text."
  // Replaying our local tail caused every turn AFTER the first to 400
  // in production (assistant turn 1 lived in `tail`, got replayed,
  // Rowboat rejected it, the stateless retry sent the SAME body and
  // 400'd again). These tests pin the contract.

  const HISTORY_TAIL = [
    { role: "user", content: "What's your purpose?" },
    { role: "assistant", content: "My purpose is to assist you…" }
  ];

  it("never sends a { role: 'assistant' } message to Rowboat, even when tail contains an assistant turn", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    await POST(jsonRequest({ businessId: BIZ, message: "and now?" }));
    const sent = vi.mocked(callRowboatChat).mock.calls[0][0].messages;
    expect(sent.some((m) => m.role === "assistant")).toBe(false);
  });

  it("on a thread WITH continuation, omits the local tail entirely on the initial call (Rowboat already has it server-side)", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    await POST(jsonRequest({ businessId: BIZ, message: "and now?" }));
    // Only the new user turn — no summary (none set), no tail
    // transcript (continuation carries it), no prior turns replayed.
    const sent = vi.mocked(callRowboatChat).mock.calls[0][0].messages;
    expect(sent).toEqual([{ role: "user", content: "and now?" }]);
  });

  it("on a stateless RETRY, replays the tail as a single system transcript so the model still has continuity", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    vi.mocked(callRowboatChat)
      .mockRejectedValueOnce(new Error("rowboat_http_400"))
      .mockResolvedValueOnce({
        reply: "fresh reply",
        conversationId: "fresh-conv",
        state: undefined,
        hasStateKey: false
      } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "and now?" }));
    const retryMessages = vi.mocked(callRowboatChat).mock.calls[1][0].messages;
    // Two messages: the synthesized recent-context system message,
    // then the new user turn. No assistant role, no plain raw replay.
    expect(retryMessages).toHaveLength(2);
    expect(retryMessages[0].role).toBe("system");
    expect(retryMessages[0].content).toContain("[Owner]: What's your purpose?");
    expect(retryMessages[0].content).toContain("[Coworker]: My purpose is to assist you");
    expect(retryMessages[1]).toEqual({ role: "user", content: "and now?" });
    expect(retryMessages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("on a fresh thread (no continuation), the FIRST call already includes the tail-as-system preamble (since there's no server-side memory to lean on)", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      rowboat_conversation_id: null,
      rowboat_state: null
    } as never);
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    await POST(jsonRequest({ businessId: BIZ, message: "and now?" }));
    const sent = vi.mocked(callRowboatChat).mock.calls[0][0].messages;
    expect(sent).toHaveLength(2);
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("[Coworker]:");
    expect(sent[1]).toEqual({ role: "user", content: "and now?" });
  });
});

describe("POST /api/dashboard/chat — Rowboat call budget", () => {
  // The dashboard-chat route's `maxDuration` is sized so the Rowboat
  // AbortController-driven "rowboat_timeout" path always wins the race
  // against Vercel's function reaper. That contract is fragile — if a
  // future change accidentally drops the per-call `timeoutMs` (or
  // raises it past `maxDuration`), the friendly-error envelope stops
  // being delivered and clients fall back to the cryptic
  // `parseEnvelope` "Unexpected server response" string. Pin the
  // budget on every call site here.

  it("passes a finite, sub-maxDuration timeoutMs on the initial call", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const callArgs = vi.mocked(callRowboatChat).mock.calls[0][0];
    expect(typeof callArgs.timeoutMs).toBe("number");
    expect(callArgs.timeoutMs).toBeGreaterThan(0);
    // `maxDuration` is 60s; budget must leave the route enough wall
    // time after the abort fires to serialize a JSON envelope.
    expect(callArgs.timeoutMs).toBeLessThan(60_000);
  });

  // The retry budget is the COMBINED ceiling minus whatever the first
  // call burned, NOT a fresh full window. Without this, a slow first
  // failure (e.g. a Cloudflare-edge 502 returned ~25s into the call)
  // plus a fresh 50s retry would push total Rowboat wall time to ~75s,
  // outliving the 60s `maxDuration` and re-triggering the same
  // Vercel-reaper race the per-route timeout was sized to avoid
  // (Codex P2 / Cursor Bugbot Medium on PR #71).

  it("retry's timeoutMs is bounded by remaining budget after the first call's elapsed time", async () => {
    // Mock Date.now() to simulate the first call eating ~20s of the
    // budget before failing. The helper reads it twice: once at entry,
    // once after the first call's catch.
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy
      .mockReturnValueOnce(1_000_000) // t0 — entry into the helper
      .mockReturnValueOnce(1_020_000); // t1 — after first call rejects (20s later)
    vi.mocked(callRowboatChat)
      .mockRejectedValueOnce(new Error("rowboat_http_500"))
      .mockResolvedValueOnce({
        reply: "fresh reply",
        conversationId: "fresh-conv",
        state: undefined,
        hasStateKey: false
      } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const firstCall = vi.mocked(callRowboatChat).mock.calls[0][0];
    const retryCall = vi.mocked(callRowboatChat).mock.calls[1][0];
    expect(firstCall.timeoutMs).toBe(50_000);
    // 50_000 (budget) - 20_000 (elapsed) = 30_000 remaining.
    expect(retryCall.timeoutMs).toBe(30_000);
    dateNowSpy.mockRestore();
  });

  it("skips the stateless retry entirely when remaining budget falls below the cold-start floor — surfaces the FIRST error instead of paying for a doomed retry", async () => {
    // First call eats 49s of the 50s budget — only 1s remains, well
    // below the 5s `RETRY_MIN_BUDGET_MS` floor. Forcing the retry
    // anyway would either succeed in a vanishingly unlikely 1s window
    // or fall over to "rowboat_timeout" (a generic envelope) when
    // we have a perfectly diagnostic first error to surface.
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(1_049_000); // 49s elapsed → 1s remaining
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_http_500"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    // 502 status w/ describeRowboatError mocked to echo the message:
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("rowboat_http_500");
    // Retry was skipped — only one Rowboat call.
    expect(vi.mocked(callRowboatChat)).toHaveBeenCalledTimes(1);
    // Continuation row must NOT be touched: we never confirmed the
    // continuation was actually stale (the retry would have proven
    // that). Clearing it now would discard a possibly-still-good
    // conversationId on a transient blip.
    expect(updateThreadConversation).not.toHaveBeenCalled();
    dateNowSpy.mockRestore();
  });

  it("still retries when the first call fails fast (almost the whole budget remains)", async () => {
    // Sanity check that the budget guard doesn't accidentally suppress
    // the common case: an immediate Rowboat 400 leaves ~50s for the
    // retry, which proceeds normally.
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(1_000_200); // 200ms elapsed
    vi.mocked(callRowboatChat)
      .mockRejectedValueOnce(new Error("rowboat_http_400"))
      .mockResolvedValueOnce({
        reply: "fresh reply",
        conversationId: "fresh-conv",
        state: undefined,
        hasStateKey: false
      } as never);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(callRowboatChat)).toHaveBeenCalledTimes(2);
    const retryCall = vi.mocked(callRowboatChat).mock.calls[1][0];
    expect(retryCall.timeoutMs).toBe(49_800); // 50_000 - 200
    dateNowSpy.mockRestore();
  });
});

describe("POST /api/dashboard/chat — summarizer trigger", () => {
  it("fires summarizeThreadAndLog when shouldSummarize returns true (fire-and-forget; doesn't await)", async () => {
    vi.mocked(shouldSummarize).mockReturnValueOnce(true);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    expect(summarizeThreadAndLog).toHaveBeenCalledWith(BIZ, ACTIVE_THREAD_ID);
  });

  it("does NOT fire summarizer when below threshold (gate keeps logs quiet on short threads)", async () => {
    vi.mocked(shouldSummarize).mockReturnValueOnce(false);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(summarizeThreadAndLog).not.toHaveBeenCalled();
  });

  it("does NOT fire summarizer if Rowboat call failed — no point summarizing a failed turn", async () => {
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_timeout"));
    vi.mocked(shouldSummarize).mockReturnValue(true);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    expect(summarizeThreadAndLog).not.toHaveBeenCalled();
    // Must also NOT have persisted any messages on a Rowboat failure.
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/chat — stateless retry on stale conversation continuation (Codex P1)", () => {
  // The bug: when threadId targets an older thread, we always send the
  // stored rowboat_conversation_id/state. Rowboat may have evicted that
  // server-side conversation (model restart, retention expiry) — without
  // this guard the entire archived thread becomes permanently
  // non-continuable, regressing the "every thread is continuable"
  // promise from the previous PR.

  const STALE_ERRORS = [
    "rowboat_http_400",
    "rowboat_http_404",
    "rowboat_http_409",
    "rowboat_http_500",
    "rowboat_http_502",
    "rowboat_http_503",
    "rowboat_empty_assistant"
  ] as const;

  for (const errMsg of STALE_ERRORS) {
    it(`retries stateless on ${errMsg} when a stored conversationId was sent — recovery instead of hard-fail`, async () => {
      // First call (with continuation) fails; second call (stateless)
      // succeeds with a fresh conversationId.
      vi.mocked(callRowboatChat)
        .mockRejectedValueOnce(new Error(errMsg))
        .mockResolvedValueOnce({
          reply: "fresh reply",
          conversationId: "fresh-conv",
          state: undefined,
          hasStateKey: false
        } as never);
      const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
      expect(res.status).toBe(200);
      // Two calls: first with continuation, second without.
      expect(callRowboatChat).toHaveBeenCalledTimes(2);
      const firstCallArgs = vi.mocked(callRowboatChat).mock.calls[0][0];
      const secondCallArgs = vi.mocked(callRowboatChat).mock.calls[1][0];
      expect(firstCallArgs.conversationId).toBe("rb-conv");
      expect(firstCallArgs.state).toEqual({ foo: 1 });
      // Stateless retry: continuation tokens dropped.
      expect(secondCallArgs.conversationId).toBeNull();
      expect(secondCallArgs.state).toBeNull();
      // With an empty `listMessages` tail (this test's default setup),
      // both calls reduce to `[{ role: "user", content: "hi" }]` —
      // there's nothing to replay either way. The shape divergence
      // (initial call omits the tail; stateless retry replays it as
      // a transcript-shaped system message) is covered by the
      // dedicated suite "Rowboat input contract (no plain assistant
      // replay)" above.
      expect(secondCallArgs.messages).toEqual(firstCallArgs.messages);
    });
  }

  it("does NOT retry on rowboat_timeout — timing out doesn't suggest stale state, retry would just double VPS load", async () => {
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_timeout"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    expect(callRowboatChat).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on rowboat_http_401 — auth is global, retrying with the same bearer would fail identically", async () => {
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_http_401"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    expect(callRowboatChat).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on rowboat_http_403 — same auth-failure reasoning as 401", async () => {
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_http_403"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    expect(callRowboatChat).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on rowboat_invalid_json — protocol-level garble, dropping continuation won't fix it", async () => {
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_invalid_json"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    expect(callRowboatChat).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the thread had NO stored conversationId — the failure isn't 'stale state' if we never sent state", async () => {
    // Fresh thread minted by getOrCreateActiveThread with null
    // conversation tokens. A retryable error here means something
    // structural (the message shape, the project, the bearer); a
    // stateless retry sends the SAME body that just failed.
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      rowboat_conversation_id: null,
      rowboat_state: null
    } as never);
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_http_404"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    expect(callRowboatChat).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when stored conversationId is whitespace-only — same 'no continuation to be stale' reasoning", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      rowboat_conversation_id: "   ",
      rowboat_state: null
    } as never);
    vi.mocked(callRowboatChat).mockRejectedValueOnce(new Error("rowboat_http_500"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    expect(callRowboatChat).toHaveBeenCalledTimes(1);
  });

  it("surfaces the RETRY error (not the first error) when the stateless fallback also fails — gives the operator the freshest signal", async () => {
    vi.mocked(callRowboatChat)
      .mockRejectedValueOnce(new Error("rowboat_http_404"))
      .mockRejectedValueOnce(new Error("rowboat_http_503"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    // describeRowboatError is mocked to echo the message; the route
    // must call it with the RETRY error, not the first one.
    expect(body.error.message).toBe("rowboat_http_503");
    expect(callRowboatChat).toHaveBeenCalledTimes(2);
  });

  it("only retries ONCE — no infinite loop when both calls fail with retryable errors", async () => {
    vi.mocked(callRowboatChat)
      .mockRejectedValueOnce(new Error("rowboat_http_500"))
      .mockRejectedValueOnce(new Error("rowboat_http_500"));
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(callRowboatChat).toHaveBeenCalledTimes(2);
  });

  // Bugbot Low (PR #66): when the stateless retry succeeds but Rowboat's
  // response omits a fresh conversationId (the field is optional in
  // RowboatTurnJson), the legacy guard `if (conversationId || state)` was
  // false and the OLD known-stale rowboat_conversation_id stayed in the DB.
  // Every subsequent message would replay the fail-then-retry cycle
  // forever, doubling latency and API load. The fix forces an UPDATE
  // whenever a stateless retry happened, even if the response carries
  // no new continuation tokens.

  it("force-clears stale rowboat_conversation_id after stateless retry, even when retry response omits a fresh one", async () => {
    vi.mocked(callRowboatChat)
      .mockRejectedValueOnce(new Error("rowboat_http_404"))
      .mockResolvedValueOnce({
        reply: "ok",
        // CRUCIAL: no conversationId returned. This is the field
        // being optional in RowboatTurnJson — Rowboat may legitimately
        // not echo one back, especially on a bare "fresh start" call.
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    // Critical: we still called updateThreadConversation, with both
    // continuation tokens nulled out. This breaks the perpetual-retry
    // loop on the next message.
    expect(updateThreadConversation).toHaveBeenCalledWith(
      ACTIVE_THREAD_ID,
      null,
      undefined
    );
  });

  it("persists the FRESH conversationId from the stateless retry response when Rowboat does provide one", async () => {
    vi.mocked(callRowboatChat)
      .mockRejectedValueOnce(new Error("rowboat_http_500"))
      .mockResolvedValueOnce({
        reply: "ok",
        conversationId: "rb-conv-fresh",
        state: { regenerated: true },
        hasStateKey: true
      } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(updateThreadConversation).toHaveBeenCalledWith(
      ACTIVE_THREAD_ID,
      "rb-conv-fresh",
      { regenerated: true }
    );
  });

  it("does NOT call updateThreadConversation when no retry happened AND Rowboat's response carries no continuation — preserves legacy 'no-op when nothing changed' semantics", async () => {
    vi.mocked(callRowboatChat).mockResolvedValueOnce({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(updateThreadConversation).not.toHaveBeenCalled();
  });
});
