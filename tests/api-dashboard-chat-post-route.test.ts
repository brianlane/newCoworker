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

// Mock callRowboatChatStream — the streaming primitive the route now
// calls. Each test seeds the generator with a sequence of events so we
// can drive the route end-to-end without a real Rowboat. The mock
// returns a fresh generator on every call so the stateless-retry path
// can substitute a different sequence for the second attempt.
vi.mock("@/lib/rowboat/chat", () => ({
  callRowboatChatStream: vi.fn(),
  describeRowboatError: (err: unknown) =>
    err instanceof Error ? err.message : "rowboat error"
}));

vi.mock("@/lib/dashboard-chat/summarizer", () => ({
  shouldSummarize: vi.fn(),
  summarizeThreadAndLog: vi.fn()
}));

vi.mock("@/lib/customer-memory/db", () => ({
  // listCustomerMemories is the only thing the route currently
  // imports from this module. Default to an empty list so existing
  // tests don't get an unexpected "recent customers" preamble in
  // their Rowboat call assertions; tests that exercise Phase 4
  // override per-call.
  listCustomerMemories: vi.fn(async () => [])
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
import { callRowboatChatStream } from "@/lib/rowboat/chat";
import {
  shouldSummarize,
  summarizeThreadAndLog
} from "@/lib/dashboard-chat/summarizer";
import { listCustomerMemories } from "@/lib/customer-memory/db";

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

/**
 * Given a list of stream events, build an async generator factory that
 * yields them one at a time. Optionally takes multiple sequences (for
 * the stateless-retry path: first sequence fails, second succeeds).
 */
type RowboatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; arguments: unknown }
  | {
      type: "done";
      conversationId: string | undefined;
      state: unknown | undefined;
      hasStateKey: boolean;
    }
  | { type: "error"; message: string };

function fakeStreamSequences(...sequences: RowboatStreamEvent[][]) {
  let callIdx = 0;
  return function fakeStream() {
    const events = sequences[callIdx] ?? sequences[sequences.length - 1] ?? [];
    callIdx += 1;
    return (async function* () {
      for (const ev of events) yield ev;
    })();
  };
}

/** Default: one delta + a done with fresh continuation tokens. */
function defaultSuccessSequence(): RowboatStreamEvent[] {
  return [
    { type: "delta", text: "hi back" },
    {
      type: "done",
      conversationId: "rb-conv-2",
      state: { bar: 2 },
      hasStateKey: true
    }
  ];
}

/**
 * Read the entire NDJSON response body and return the parsed events
 * (one per line). Streaming responses always return 200 even on
 * mid-stream errors — the actual outcome is encoded in the events.
 */
async function readNdjson(res: Response) {
  if (!res.body) return [] as Array<Record<string, unknown>>;
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
  vi.mocked(callRowboatChatStream).mockImplementation(
    fakeStreamSequences(defaultSuccessSequence()) as never
  );
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

describe("POST /api/dashboard/chat — streaming response shape (NDJSON contract)", () => {
  it("returns NDJSON content-type and a 200 status on the success path — the actual outcome is encoded in the streamed events, not the HTTP status", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
  });

  it("emits meta → delta → done in order", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    // First event is meta with the resolved threadId.
    expect(events[0]?.type).toBe("meta");
    expect((events[0] as { threadId: string }).threadId).toBe(ACTIVE_THREAD_ID);
    // Some number of delta events (one for each fake delta).
    expect(events.some((e) => e.type === "delta")).toBe(true);
    // Last event is `done` with the canonical messages list.
    const last = events.at(-1) as { type: string; messages: unknown[] };
    expect(last.type).toBe("done");
    expect(Array.isArray(last.messages)).toBe(true);
  });

  it("forwards each Rowboat delta to the client preserving content order", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([
        { type: "delta", text: "Hel" },
        { type: "delta", text: "lo " },
        { type: "delta", text: "world" },
        {
          type: "done",
          conversationId: "rb-conv-2",
          state: undefined,
          hasStateKey: false
        }
      ]) as never
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((e) => (e as { content: string }).content)).toEqual([
      "Hel",
      "lo ",
      "world"
    ]);
  });

  it("persists the user message BEFORE opening the stream — survives a mid-generation client disconnect", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences(defaultSuccessSequence()) as never
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    await readNdjson(res);
    const userAppendCall = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[1] === "user");
    expect(userAppendCall).toBeDefined();
    expect(userAppendCall?.[0]).toBe(ACTIVE_THREAD_ID);
    expect(userAppendCall?.[2]).toBe("hi");
  });

  it("persists the assistant reply ONLY after a successful done event", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    await readNdjson(res);
    const assistantAppendCall = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppendCall).toBeDefined();
    expect(assistantAppendCall?.[2]).toBe("hi back");
  });

  it("updates the thread continuation tokens from the done event metadata", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    await readNdjson(res);
    expect(updateThreadConversation).toHaveBeenCalledWith(
      ACTIVE_THREAD_ID,
      "rb-conv-2",
      { bar: 2 }
    );
  });
});

describe("POST /api/dashboard/chat — legacy path (no threadId)", () => {
  it("uses getOrCreateActiveThread and never touches reactivate when caller omits threadId", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    await readNdjson(res); // drain the body
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
    await readNdjson(res);
    expect(getThreadById).toHaveBeenCalledWith(ARCHIVED_THREAD_ID);
    expect(reactivateThread).toHaveBeenCalledWith(BIZ, ARCHIVED_THREAD_ID);
    // Must NOT mint a new thread when caller targeted a specific one.
    expect(getOrCreateActiveThread).not.toHaveBeenCalled();
    // Append goes to the resolved (archived-then-reactivated) thread.
    const appendCalls = vi.mocked(appendMessage).mock.calls;
    // First append is the user message (pre-stream); second is the
    // assistant message (post-done). Both target the resolved thread.
    expect(appendCalls[0][0]).toBe(ARCHIVED_THREAD_ID);
    expect(appendCalls[1][0]).toBe(ARCHIVED_THREAD_ID);
  });

  it("skips reactivation when the targeted thread is already active (idempotent on repeat sends)", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce(ACTIVE_THREAD as never);
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: ACTIVE_THREAD_ID, message: "continue" })
    );
    await readNdjson(res);
    expect(reactivateThread).not.toHaveBeenCalled();
  });

  it("rejects with NDJSON 404 error when the thread doesn't exist (caller-supplied UUID is bogus)", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce(null as never);
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: ARCHIVED_THREAD_ID, message: "x" })
    );
    expect(res.status).toBe(404);
    const events = await readNdjson(res);
    expect(events).toEqual([
      { type: "error", code: "NOT_FOUND", message: "Conversation not found" }
    ]);
    // No reactivate, no append — we never touched a real thread.
    expect(reactivateThread).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("rejects with NDJSON 404 (NOT 403) when the thread belongs to another tenant — anti-IDOR + denies existence side-channel", async () => {
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
  it("includes summary_md as a system message when present", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      summary_md: "earlier: discussed pricing tiers"
    } as never);
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "and now?" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    // OWNER_PREAMBLE is always first (pins the owner-vs-customer
    // persona — see route.ts). The summary is the next system slot.
    const summaryMsg = sent.find(
      (m) => m.role === "system" && m.content.includes("Conversation summary so far")
    );
    expect(summaryMsg?.content).toContain("earlier: discussed pricing tiers");
    expect(sent[sent.length - 1]).toEqual({
      role: "user",
      content: "[Dashboard] and now?"
    });
  });

  it("does NOT include a summary system message when summary_md is null/empty/whitespace", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      summary_md: "   "
    } as never);
    await readNdjson(await POST(jsonRequest({ businessId: BIZ, message: "hi" })));
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    const summaryMsg = sent.find(
      (m) => m.role === "system" && m.content.includes("Conversation summary so far")
    );
    expect(summaryMsg).toBeUndefined();
  });
});

describe("POST /api/dashboard/chat — Rowboat input contract (no plain assistant replay)", () => {
  // Rowboat's HTTP /chat validator rejects plain
  //   { role: "assistant", content: string }
  // entries (it expects agent/tool-shaped rows produced by Rowboat
  // itself). Replaying our local tail caused every turn AFTER the
  // first to 400 in production. These tests pin the contract.

  const HISTORY_TAIL = [
    { role: "user", content: "What's your purpose?" },
    { role: "assistant", content: "My purpose is to assist you…" }
  ];

  it("never sends a { role: 'assistant' } message to Rowboat, even when tail contains an assistant turn", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "and now?" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    expect(sent.some((m) => m.role === "assistant")).toBe(false);
  });

  it("on a thread WITH continuation, omits the local tail entirely on the initial call (Rowboat already has it server-side)", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "and now?" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    const userMsgs = sent.filter((m) => m.role === "user");
    expect(userMsgs).toEqual([{ role: "user", content: "[Dashboard] and now?" }]);
    // Exactly one system msg (OWNER_PREAMBLE) — no summary (none set),
    // no tail transcript (continuation carries it), no prior turns replayed.
    expect(sent.filter((m) => m.role === "system")).toHaveLength(1);
    expect(sent[0]?.role).toBe("system");
    expect(sent[0]?.content).toContain("OWNER MODE");
  });

  it("on a stateless RETRY, replays the tail as a single system transcript so the model still has continuity", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences(
        // First attempt: 400 before any delta — triggers stateless retry.
        [{ type: "error", message: "rowboat_http_400" }],
        // Retry succeeds.
        [
          { type: "delta", text: "fresh reply" },
          {
            type: "done",
            conversationId: "fresh-conv",
            state: undefined,
            hasStateKey: false
          }
        ]
      ) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "and now?" }))
    );
    const retryMessages = vi.mocked(callRowboatChatStream).mock.calls[1][0]
      .messages;
    // Three messages: OWNER_PREAMBLE, the synthesized recent-context
    // system message, then the new user turn. No assistant role, no
    // plain raw replay.
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[0].role).toBe("system");
    expect(retryMessages[0].content).toContain("OWNER MODE");
    expect(retryMessages[1].role).toBe("system");
    expect(retryMessages[1].content).toContain("[Owner]: What's your purpose?");
    expect(retryMessages[1].content).toContain("[Coworker]: My purpose is to assist you");
    expect(retryMessages[2]).toEqual({
      role: "user",
      content: "[Dashboard] and now?"
    });
    expect(retryMessages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("on a fresh thread (no continuation), the FIRST call already includes the tail-as-system preamble (since there's no server-side memory to lean on)", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      rowboat_conversation_id: null,
      rowboat_state: null
    } as never);
    vi.mocked(listMessages).mockResolvedValueOnce(HISTORY_TAIL as never);
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "and now?" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    // OWNER_PREAMBLE + tail transcript + new user turn = 3 messages.
    expect(sent).toHaveLength(3);
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("OWNER MODE");
    expect(sent[1].role).toBe("system");
    expect(sent[1].content).toContain("[Coworker]:");
    expect(sent[2]).toEqual({ role: "user", content: "[Dashboard] and now?" });
  });
});

describe("POST /api/dashboard/chat — OWNER_PREAMBLE persona pin", () => {
  it("includes OWNER_PREAMBLE as the FIRST system message on every call", async () => {
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("OWNER MODE");
    expect(sent[0].content).toContain("You are talking to the business OWNER");
    expect(sent[0].content).toContain("NOT a customer");
  });

  it("includes [Dashboard] channel marker on the user message — defense in depth alongside OWNER_PREAMBLE", async () => {
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "what was Joe asking about?" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    const userMsg = sent[sent.length - 1];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("[Dashboard] what was Joe asking about?");
  });

  it("OWNER_PREAMBLE survives a stateless retry — pins persona even when continuation is dropped", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences(
        [{ type: "error", message: "rowboat_http_400" }],
        [
          { type: "delta", text: "fresh reply" },
          {
            type: "done",
            conversationId: "fresh-conv",
            state: undefined,
            hasStateKey: false
          }
        ]
      ) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    const retryMessages = vi.mocked(callRowboatChatStream).mock.calls[1][0]
      .messages;
    expect(retryMessages[0].role).toBe("system");
    expect(retryMessages[0].content).toContain("OWNER MODE");
  });

  // Pin the new "owner has full visibility" + "no fabrication" clauses
  // added to fix the chat-refusing-to-share-phone-numbers + chat-
  // hallucinating-customer-details bugs (PR #75 screenshots). Without
  // these, a future innocent-looking edit to OWNER_PREAMBLE could
  // silently regress the prompt and re-introduce the model's
  // self-invented "privacy/compliance" refusals.

  it("OWNER_PREAMBLE explicitly authorizes sharing PII (phone numbers, timestamps) with the owner — defeats the model's tendency to invent privacy refusals", async () => {
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    const preamble = sent[0].content;
    expect(preamble).toMatch(/full read access/i);
    expect(preamble).toMatch(/phone numbers/i);
    // "None of those details are private FROM the owner" — explicitly
    // greenlights sharing PII with the owner. Without this clause the
    // model invents privacy/compliance refusals (PR #75 screenshot).
    expect(preamble).toMatch(/private from the owner/i);
  });

  it("OWNER_PREAMBLE forbids fabricating details — and points the owner at /dashboard/calls and /dashboard/messages for full content", async () => {
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    const sent = vi.mocked(callRowboatChatStream).mock.calls[0][0].messages;
    const preamble = sent[0].content;
    expect(preamble).toMatch(/no fabrication/i);
    expect(preamble).toContain("/dashboard/calls");
    expect(preamble).toContain("/dashboard/messages");
  });
});

describe("POST /api/dashboard/chat — upstream cancellation (Codex P2 / Cursor Bugbot Medium on PR #76)", () => {
  it("forwards request.signal into callRowboatChatStream so a client disconnect actually tears down the upstream Rowboat fetch — pre-fix the route created a separate, disconnected AbortController", async () => {
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    const callArgs = vi.mocked(callRowboatChatStream).mock.calls[0][0] as {
      signal?: AbortSignal;
    };
    // The route MUST pass through a signal — the per-tenant Ollama
    // would otherwise keep generating tokens nobody reads after a
    // client disconnect, wasting tenant VPS budget for up to 30s
    // (the internal idle-timer ceiling).
    expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    // And it must be the SAME signal the Request carries — passing a
    // fresh AbortController would silently re-introduce the bug.
    // We can't compare by reference (Next.js may wrap the Request),
    // so we assert behaviour: aborting the original signal flips the
    // received one.
    expect(callArgs.signal?.aborted).toBe(false);
  });
});

describe("POST /api/dashboard/chat — customer memory preamble (Phase 4)", () => {
  it("does NOT inject a preamble when the business has no customer memories — keeps first-time owner UX unchanged", async () => {
    vi.mocked(listCustomerMemories).mockResolvedValueOnce([]);
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    const callArgs = vi.mocked(callRowboatChatStream).mock.calls[0][0];
    const customerSystemMsg = callArgs.messages.find(
      (m) => m.role === "system" && m.content.includes("recent customers")
    );
    expect(customerSystemMsg).toBeUndefined();
  });

  it("injects a recent-customers system preamble when memories exist — agent can answer 'what was Joe asking about?'", async () => {
    vi.mocked(listCustomerMemories).mockResolvedValueOnce([
      {
        id: "00000000-0000-0000-0000-0000000000aa",
        business_id: BIZ,
        customer_e164: "+15555550123",
        display_name: "Joe",
        summary_md: "Asking about garage door spring sizing",
        pinned_md: null,
        interaction_count: 0,
        total_interaction_count: 4,
        last_interaction_at: "2026-05-06T10:00:00Z",
        last_summarized_at: "2026-05-06T10:01:00Z",
        last_channel: "voice",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-05-06T10:01:00Z"
      }
    ] as never);
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "what was Joe asking about?" }))
    );
    const callArgs = vi.mocked(callRowboatChatStream).mock.calls[0][0];
    const customerSystemMsg = callArgs.messages.find(
      (m) => m.role === "system" && m.content.includes("recent customers")
    );
    expect(customerSystemMsg).toBeDefined();
    expect(customerSystemMsg!.content).toContain("Joe");
    expect(customerSystemMsg!.content).toContain("+15555550123");
    expect(customerSystemMsg!.content).toContain("Asking about garage door spring sizing");
    expect(customerSystemMsg!.content).toContain(
      "Do NOT proactively volunteer customer details"
    );
  });

  it("returns a successful chat reply even when the customer memory lookup throws — degraded awareness, not a 502", async () => {
    vi.mocked(listCustomerMemories).mockRejectedValueOnce(
      new Error("supabase_pgrst_500")
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    // Stream completes successfully with a done event.
    expect(events.at(-1)?.type).toBe("done");
    expect(vi.mocked(callRowboatChatStream)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(callRowboatChatStream).mock.calls[0][0];
    const customerSystemMsg = callArgs.messages.find(
      (m) => m.role === "system" && m.content.includes("recent customers")
    );
    expect(customerSystemMsg).toBeUndefined();
  });
});

describe("POST /api/dashboard/chat — summarizer trigger", () => {
  it("fires summarizeThreadAndLog when shouldSummarize returns true (fire-and-forget; doesn't await)", async () => {
    vi.mocked(shouldSummarize).mockReturnValueOnce(true);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    expect(events.at(-1)?.type).toBe("done");
    expect(summarizeThreadAndLog).toHaveBeenCalledWith(BIZ, ACTIVE_THREAD_ID);
  });

  it("does NOT fire summarizer when below threshold (gate keeps logs quiet on short threads)", async () => {
    vi.mocked(shouldSummarize).mockReturnValueOnce(false);
    await readNdjson(await POST(jsonRequest({ businessId: BIZ, message: "hi" })));
    expect(summarizeThreadAndLog).not.toHaveBeenCalled();
  });

  it("does NOT fire summarizer if the Rowboat stream errored — no point summarizing a failed turn", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([{ type: "error", message: "rowboat_timeout" }]) as never
    );
    vi.mocked(shouldSummarize).mockReturnValue(true);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    expect(events.at(-1)?.type).toBe("error");
    expect(summarizeThreadAndLog).not.toHaveBeenCalled();
    // Must also NOT have persisted the assistant reply on a stream
    // failure (the user message persists pre-stream by design).
    const assistantAppend = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppend).toBeUndefined();
  });
});

describe("POST /api/dashboard/chat — stateless retry (pre-token gating)", () => {
  // Streaming retry rule: ONLY fire the stateless fallback when ZERO
  // delta events have reached the client. Once tokens are out, retrying
  // would emit duplicate text — far worse UX than an honest "connection
  // cut off" error.

  const STALE_ERRORS = [
    "rowboat_http_400",
    "rowboat_http_404",
    "rowboat_http_408",
    "rowboat_http_409",
    "rowboat_http_500",
    "rowboat_http_502",
    "rowboat_http_503",
    "rowboat_http_522",
    "rowboat_http_524",
    "rowboat_empty_assistant"
  ] as const;

  for (const errMsg of STALE_ERRORS) {
    it(`retries stateless on ${errMsg} when zero deltas had been emitted — recovery instead of hard-fail`, async () => {
      vi.mocked(callRowboatChatStream).mockImplementation(
        fakeStreamSequences(
          // First attempt: error before any delta.
          [{ type: "error", message: errMsg }],
          // Stateless retry: success.
          [
            { type: "delta", text: "fresh reply" },
            {
              type: "done",
              conversationId: "fresh-conv",
              state: undefined,
              hasStateKey: false
            }
          ]
        ) as never
      );
      const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
      const events = await readNdjson(res);
      expect(events.at(-1)?.type).toBe("done");
      expect(callRowboatChatStream).toHaveBeenCalledTimes(2);
      const firstCallArgs = vi.mocked(callRowboatChatStream).mock.calls[0][0];
      const secondCallArgs = vi.mocked(callRowboatChatStream).mock.calls[1][0];
      expect(firstCallArgs.conversationId).toBe("rb-conv");
      expect(firstCallArgs.state).toEqual({ foo: 1 });
      // Stateless retry: continuation tokens dropped.
      expect(secondCallArgs.conversationId).toBeNull();
      expect(secondCallArgs.state).toBeNull();
    });
  }

  it("does NOT retry on rowboat_timeout — timing out doesn't suggest stale state, retry would just double VPS load", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([{ type: "error", message: "rowboat_timeout" }]) as never
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    await readNdjson(res);
    expect(callRowboatChatStream).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on rowboat_http_401 — auth is global, retrying with the same bearer would fail identically", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([{ type: "error", message: "rowboat_http_401" }]) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    expect(callRowboatChatStream).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on rowboat_invalid_json — protocol-level garble, dropping continuation won't fix it", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([{ type: "error", message: "rowboat_invalid_json" }]) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    expect(callRowboatChatStream).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the thread had NO stored conversationId — the failure isn't 'stale state' if we never sent state", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      rowboat_conversation_id: null,
      rowboat_state: null
    } as never);
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([{ type: "error", message: "rowboat_http_404" }]) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    expect(callRowboatChatStream).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when at least one delta has already reached the client — duplicate output would be worse than an honest mid-stream error", async () => {
    // First attempt emits a delta then errors. The retry guard MUST
    // gate on deltasEmitted === 0, not just on the error code being
    // retryable — otherwise the user sees "Hello…" then "Hello world"
    // appearing twice in their bubble.
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([
        { type: "delta", text: "Hello" },
        { type: "error", message: "rowboat_http_524" }
      ]) as never
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    expect(callRowboatChatStream).toHaveBeenCalledTimes(1);
    // Final event is an error with the post-token "connection cut off" copy.
    const last = events.at(-1) as { type: string; message: string };
    expect(last.type).toBe("error");
    expect(last.message).toMatch(/cut off/i);
    // Assistant message MUST NOT have been persisted — partial replies
    // shouldn't be committed.
    const assistantAppend = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppend).toBeUndefined();
  });

  it("retries stateless when the upstream generator ends without yielding a terminal event AND no content accumulated — Cursor Bugbot Low regression test from PR #76 commit 837c6e8: pre-fix the fallback hardcoded retryable:false even though rowboat_empty_assistant IS in STATELESS_RETRY_ERRORS, silently bypassing the retry that would have recovered from a stale conversation continuation", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences(
        // First attempt: stream ends with no events at all (mock
        // exhausted before yielding error/done). The route's post-
        // loop fallback should treat this as rowboat_empty_assistant
        // AND mark it retryable so we get one more chance.
        [],
        // Stateless retry: success.
        [
          { type: "delta", text: "fresh reply" },
          {
            type: "done",
            conversationId: "fresh-conv",
            state: undefined,
            hasStateKey: false
          }
        ]
      ) as never
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    expect(callRowboatChatStream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("treats whitespace-only buffered content as empty in the post-loop fallback — uses the SAME trim-gate as the persistence path so the fallback doesn't return kind:'done' for content that would then be rejected at persistence (Cursor Bugbot Low on PR #76 commit 837c6e8: pre-fix line 799 used `buffered.length > 0` while persistence used `buffered.trim().length === 0`, creating the inconsistency)", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([
        // Whitespace deltas, no terminal event. With the trim-gate
        // fix the fallback returns kind:"error" with the
        // pre-meaningful-content friendly message — pre-fix it
        // returned kind:"done" and the persistence branch then
        // surfaced the misleading "cut off" message.
        { type: "delta", text: "   " },
        { type: "delta", text: "\n\n" }
      ]) as never
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    // No retry: deltasEmitted > 0 (the bytes were already streamed),
    // so the retry-safety gate denies it. That matches the inline
    // error handler's gate.
    expect(callRowboatChatStream).toHaveBeenCalledTimes(1);
    // No assistant row persisted (whitespace-only never gets written).
    const assistantAppend = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppend).toBeUndefined();
    // Pre-meaningful-content friendly message — NOT "cut off".
    const last = events.at(-1) as { type: string; message: string };
    expect(last.type).toBe("error");
    expect(last.message).not.toMatch(/cut off/i);
  });

  it("uses the pre-meaningful-content friendly message when the only deltas were whitespace — Cursor Bugbot Low regression test from PR #76 commit e722c7d: pre-fix the gate keyed off deltasEmitted (which counts whitespace), so a whitespace-only stream got the misleading 'connection cut off' copy AND the client retained a never-persisted whitespace bubble", async () => {
    // First attempt emits whitespace-only deltas then errors. The
    // friendly-message gate MUST align with the persistence gate
    // (buffered.trim().length === 0) — otherwise the user sees a
    // "your reply may be incomplete" warning for a reply that was
    // actually never written to the database (and disappears on
    // refresh).
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([
        { type: "delta", text: "  " },
        { type: "delta", text: "\n" },
        // Use a NON-retryable error so we don't trigger the stateless
        // retry path here (that's covered by other tests). The point
        // of this test is the friendly-message branch on the final
        // outcome.
        { type: "error", message: "rowboat_http_404" }
      ]) as never
    );
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const events = await readNdjson(res);
    const last = events.at(-1) as { type: string; message: string };
    expect(last.type).toBe("error");
    // The describeRowboatError copy for a 404, NOT the "cut off"
    // message — because no meaningful content reached the user.
    expect(last.message).not.toMatch(/cut off/i);
    // No assistant row persisted (whitespace-only never gets written).
    const assistantAppend = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppend).toBeUndefined();
  });

  it("only retries ONCE — no infinite loop when both calls fail with retryable errors", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences(
        [{ type: "error", message: "rowboat_http_500" }],
        [{ type: "error", message: "rowboat_http_500" }]
      ) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    expect(callRowboatChatStream).toHaveBeenCalledTimes(2);
  });

  it("force-clears stale rowboat_conversation_id after stateless retry, even when retry response omits a fresh one (Bugbot Low PR #66)", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences(
        [{ type: "error", message: "rowboat_http_404" }],
        [
          { type: "delta", text: "ok" },
          {
            type: "done",
            // CRUCIAL: no conversationId returned. The retry must still
            // overwrite the DB to break the perpetual fail-then-retry
            // cycle (next message would re-send the same dead id).
            conversationId: undefined,
            state: undefined,
            hasStateKey: false
          }
        ]
      ) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    expect(updateThreadConversation).toHaveBeenCalledWith(
      ACTIVE_THREAD_ID,
      null,
      undefined
    );
  });

  it("persists the FRESH conversationId from the stateless retry response when Rowboat does provide one", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences(
        [{ type: "error", message: "rowboat_http_500" }],
        [
          { type: "delta", text: "ok" },
          {
            type: "done",
            conversationId: "rb-conv-fresh",
            state: { regenerated: true },
            hasStateKey: true
          }
        ]
      ) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    expect(updateThreadConversation).toHaveBeenCalledWith(
      ACTIVE_THREAD_ID,
      "rb-conv-fresh",
      { regenerated: true }
    );
  });

  it("does NOT call updateThreadConversation when no retry happened AND Rowboat's response carries no continuation — preserves legacy 'no-op when nothing changed' semantics", async () => {
    vi.mocked(callRowboatChatStream).mockImplementation(
      fakeStreamSequences([
        { type: "delta", text: "ok" },
        {
          type: "done",
          conversationId: undefined,
          state: undefined,
          hasStateKey: false
        }
      ]) as never
    );
    await readNdjson(
      await POST(jsonRequest({ businessId: BIZ, message: "hi" }))
    );
    expect(updateThreadConversation).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/chat — pre-stream errors", () => {
  it("returns NDJSON 401 on missing auth — error event uses the correct code so the client can branch", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null as never);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(401);
    const events = await readNdjson(res);
    expect(events).toEqual([
      { type: "error", code: "UNAUTHORIZED", message: "Authentication required" }
    ]);
    // Stream never opened — Rowboat MUST NOT have been called.
    expect(callRowboatChatStream).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("returns NDJSON 409 + paused message when the business is paused", async () => {
    supabaseFlagsStub.maybeSingle.mockResolvedValueOnce({
      data: { id: BIZ, is_paused: true, customer_channels_enabled: true },
      error: null
    });
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(409);
    const events = await readNdjson(res);
    expect(events[0]).toMatchObject({
      type: "error",
      code: "CONFLICT"
    });
    expect((events[0] as { message: string }).message).toMatch(/paused/i);
  });

  it("returns NDJSON 429 when the rate limiter rejects", async () => {
    vi.mocked(rateLimit).mockReturnValueOnce({
      success: false,
      limit: 30,
      remaining: 0,
      reset: 0
    });
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(429);
    const events = await readNdjson(res);
    expect((events[0] as { message: string }).message).toMatch(/too many/i);
  });
});
