import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn()
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
    touchChatActivity: vi.fn()
  };
});

vi.mock("@/lib/db/dashboard-chat-jobs", () => ({
  insertChatJob: vi.fn()
}));

vi.mock("@/lib/customer-memory/db", () => ({
  // listCustomerMemories is the only thing the route currently
  // imports from this module. Default to an empty list so existing
  // tests don't get an unexpected "recent customers" preamble in
  // their job input assertions; tests that exercise Phase 4
  // override per-call.
  listCustomerMemories: vi.fn(async () => [])
}));

const supabaseFlagsStub = {
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  update: vi.fn(),
  maybeSingle: vi.fn()
};
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseFlagsStub)
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  // Batched gates read; every key defaults OFF here so tests that exercise
  // an enabled path flip it per-call via gateStates(true).
  getAgentToolStates: vi.fn()
}));

vi.mock("@/lib/db/chat-usage", () => ({
  // Under-cap by default; the over-cap/fallback tests override per-call.
  getChatSpendSnapshotForBusiness: vi.fn(async () => ({
    periodStart: "2026-07-01T00:00:00.000Z",
    spendMicros: 0,
    baseCapMicros: 10_000_000,
    creditMicros: 0,
    effectiveCapMicros: 10_000_000
  }))
}));

vi.mock("@/lib/dashboard-chat/inline-turn", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dashboard-chat/inline-turn")>(
    "@/lib/dashboard-chat/inline-turn"
  );
  return { ...actual, runInlineChatTurn: vi.fn() };
});

vi.mock("@/lib/dashboard-chat/schedule-memory-capture", () => ({
  scheduleCaptureOwnerRuleInline: vi.fn()
}));

vi.mock("@/lib/dashboard-chat/summarizer", () => ({
  shouldSummarize: vi.fn(() => false),
  summarizeThread: vi.fn(async () => ({ ok: true, summary: "" }))
}));

vi.mock("@/lib/voice-tools/connections", () => ({
  // Default: nothing connected, the integrations status line still renders
  // (with "not connected" arms); tests that exercise providers override.
  resolveCalendarConnection: vi.fn(async () => null),
  resolveEmailConnection: vi.fn(async () => null)
}));

vi.mock("@/lib/db/business-members", () => ({
  // Default: the chatting user is the owner, so role-gated tool declarations
  // (update_notification_preferences) stay available in existing tests.
  getBusinessRoleForEmail: vi.fn(async () => "owner")
}));

// Admin view-as: the route asks for the pinned business id when the caller
// is the platform admin. Mocked because the real reader needs a request-scoped
// cookie store; default is "no view-as", so non-admin cases are untouched.
vi.mock("@/lib/admin/view-as", () => ({
  getViewAsBusinessId: vi.fn(async () => null)
}));

import { POST, renderTailTranscript } from "@/app/api/dashboard/chat/route";
import { getViewAsBusinessId } from "@/lib/admin/view-as";
import { getAgentToolStates } from "@/lib/db/agent-tool-settings";

/** Point the batched gates mock at a uniform enabled state for every key. */
function gateStates(enabled: boolean) {
  vi.mocked(getAgentToolStates).mockImplementation(
    async (_biz: string, _agent: string, keys: readonly string[]) =>
      Object.fromEntries(keys.map((k) => [k, enabled]))
  );
}
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  appendMessage,
  deactivateActiveThread,
  getOrCreateActiveThread,
  getThreadById,
  listMessages,
  reactivateThread,
  touchChatActivity
} from "@/lib/db/dashboard-chat";
import { insertChatJob } from "@/lib/db/dashboard-chat-jobs";
import { listCustomerMemories } from "@/lib/customer-memory/db";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import {
  resolveCalendarConnection,
  resolveEmailConnection
} from "@/lib/voice-tools/connections";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";

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

const FAKE_JOB_ID = "55555555-5555-4555-8555-555555555555";
const FAKE_USER_MSG = { id: 99, role: "user" as const, content: "hi", created_at: "now" };

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function readEnvelope(res: Response): Promise<{
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}> {
  const text = await res.text();
  return JSON.parse(text);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "owner@example.com",
    isAdmin: false
  } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  gateStates(false);
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 30,
    remaining: 29,
    reset: 0
  });

  // Business flags: not paused, customer channels enabled.
  supabaseFlagsStub.from.mockReturnValue(supabaseFlagsStub);
  supabaseFlagsStub.select.mockReturnValue(supabaseFlagsStub);
  // `.eq()` terminates BOTH the flags read chain (before .maybeSingle) and
  // the inline path's thread-bump update chain (awaited directly), a
  // non-thenable return works for the latter (await passes it through and
  // `error` destructures to undefined).
  supabaseFlagsStub.eq.mockReturnValue(supabaseFlagsStub);
  supabaseFlagsStub.update.mockReturnValue(supabaseFlagsStub);
  supabaseFlagsStub.maybeSingle.mockResolvedValue({
    data: {
      id: BIZ,
      is_paused: false,
      customer_channels_enabled: true
    },
    error: null
  });

  vi.mocked(getOrCreateActiveThread).mockResolvedValue(ACTIVE_THREAD as never);
  vi.mocked(getThreadById).mockResolvedValue(ARCHIVED_THREAD as never);
  vi.mocked(reactivateThread).mockResolvedValue(undefined as never);
  vi.mocked(listMessages).mockResolvedValue([] as never);
  vi.mocked(appendMessage).mockResolvedValue(FAKE_USER_MSG as never);
  vi.mocked(touchChatActivity).mockResolvedValue(undefined as never);
  vi.mocked(insertChatJob).mockResolvedValue({
    id: FAKE_JOB_ID,
    business_id: BIZ,
    thread_id: ACTIVE_THREAD_ID,
    user_message_id: FAKE_USER_MSG.id,
    status: "queued",
    attempts: 0,
    claimed_by: null,
    claimed_at: null,
    assistant_message_id: null,
    input_messages: [],
    stateless_input_messages: null,
    rowboat_conversation_id: "rb-conv",
    error_code: null,
    error_detail: null,
    created_at: "now",
    started_at: null,
    completed_at: null
  } as never);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/dashboard/chat, enqueue-and-return contract (PR #79)", () => {
  it("returns 200 with the JSON envelope { threadId, activeThreadId, jobId, userMessageId, messages }, the worker handles Rowboat off-Vercel", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    const env = await readEnvelope(res);
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      threadId: ACTIVE_THREAD_ID,
      activeThreadId: ACTIVE_THREAD_ID,
      jobId: FAKE_JOB_ID,
      userMessageId: FAKE_USER_MSG.id
    });
    expect(Array.isArray(env.data?.messages)).toBe(true);
  });

  it("response is plain JSON, not NDJSON, the streaming surface from PR #76-#78 is gone", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/application\/json/);
    expect(ct).not.toMatch(/x-ndjson/);
  });

  it("accepts a long pasted brief (16k cap, the old 4000 clipped onboarding docs mid-sentence)", async () => {
    const brief = "K".repeat(15_999);
    const res = await POST(jsonRequest({ businessId: BIZ, message: brief }));
    expect(res.status).toBe(200);
    const userAppendCall = vi.mocked(appendMessage).mock.calls.find((c) => c[1] === "user");
    expect(userAppendCall?.[2]).toBe(brief);

    const over = await POST(jsonRequest({ businessId: BIZ, message: "K".repeat(16_001) }));
    expect(over.status).toBe(400);
  });

  it("persists the user message BEFORE enqueueing, if the enqueue fails the typed message is still saved", async () => {
    // Force insertChatJob to throw to verify ordering. appendMessage
    // must still have run with the user's text.
    vi.mocked(insertChatJob).mockRejectedValueOnce(new Error("queue down"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "save me" }));
    // 5xx surfaces from handleRouteError; the user message persisted regardless.
    expect(res.status).toBeGreaterThanOrEqual(500);
    const userAppendCall = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[1] === "user");
    expect(userAppendCall?.[0]).toBe(ACTIVE_THREAD_ID);
    expect(userAppendCall?.[2]).toBe("save me");
  });

  it("forwards the rowboat_conversation_id from the thread row to the job, worker uses it as the first-attempt continuation", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    expect(callArgs.rowboatConversationId).toBe("rb-conv");
  });

  it("the route NEVER calls Rowboat, generation moved to the VPS chat-worker", async () => {
    // Sanity: nothing in @/lib/rowboat/chat is imported by the route
    // anymore, so a snapshot of the request just shouldn't end up
    // touching it. We assert by checking that no fetch to a rowboat
    // URL happened, the route only persists + enqueues.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("rowboat"))).toBe(false);
    fetchSpy.mockRestore();
  });
});

describe("POST /api/dashboard/chat, two input variants for the worker (stateless retry)", () => {
  // The worker is the one that handles try-then-fallback. The route's
  // job is to BUILD both variants up front and stash them on the job
  // row so the worker has zero business logic to duplicate.

  it("on a thread WITH continuation, inputMessages NOW includes a bounded recent tail (deterministic recall, not Rowboat-replay-only), and statelessInputMessages includes the full tail (used if the convId is rejected)", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([
      { role: "user", content: "earlier user turn" },
      { role: "assistant", content: "earlier assistant turn" }
    ] as never);
    await POST(jsonRequest({ businessId: BIZ, message: "and now?" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    // First-attempt input: OWNER_PREAMBLE + bounded recent tail + user turn.
    // We deliberately resend the tail even on continuation now (the small
    // per-tenant model lost earlier turns when recall relied on Rowboat
    // replay alone, see route.ts buildRowboatChatMessages doc).
    const primary = callArgs.inputMessages;
    expect(primary.some((m) => m.role === "system" && m.content.includes("OWNER MODE"))).toBe(true);
    expect(primary.some((m) => m.content.includes("[Coworker]: earlier assistant turn"))).toBe(
      true
    );
    expect(primary.some((m) => m.content.includes("[Owner]: earlier user turn"))).toBe(true);
    // Last message is the new user turn with the [Dashboard] tag.
    expect(primary[primary.length - 1]).toEqual({
      role: "user",
      content: "[Dashboard] and now?"
    });
    // Stateless variant: also includes the tail-as-system reference (full tail).
    const fallback = callArgs.statelessInputMessages;
    expect(fallback).not.toBeNull();
    expect(fallback!.some((m) => m.content.includes("[Coworker]: earlier assistant turn"))).toBe(
      true
    );
    expect(fallback!.some((m) => m.content.includes("[Owner]: earlier user turn"))).toBe(true);
  });

  it("on a fresh thread (no continuation), inputMessages already includes the tail AND statelessInputMessages is null, there's no fallback to escalate to", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      rowboat_conversation_id: null
    } as never);
    vi.mocked(listMessages).mockResolvedValueOnce([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" }
    ] as never);
    await POST(jsonRequest({ businessId: BIZ, message: "next" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    // First-attempt input HAS the tail (no Rowboat state to lean on).
    expect(
      callArgs.inputMessages.some((m) => m.content.includes("[Owner]: earlier"))
    ).toBe(true);
    // Stateless variant explicitly null → worker won't retry on its
    // own. A fresh-thread failure is a real error, not a stale-state
    // recoverable one.
    expect(callArgs.statelessInputMessages).toBeNull();
  });

  it("never sends a { role: 'assistant' } message to the worker, Rowboat's input validator rejects plain assistant rows", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([
      { role: "user", content: "what's up" },
      { role: "assistant", content: "all good" }
    ] as never);
    await POST(jsonRequest({ businessId: BIZ, message: "next" }));
    const { inputMessages, statelessInputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    expect(inputMessages.some((m) => m.role === "assistant")).toBe(false);
    expect((statelessInputMessages ?? []).some((m) => m.role === "assistant")).toBe(false);
  });
});

describe("POST /api/dashboard/chat, email tool preamble (Settings → Coworker tools)", () => {
  it("injects the DISABLED block by default, the model is told to never pretend to send", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "send an email to bob@x.co" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    const emailBlock = inputMessages.find(
      (m) => m.role === "system" && m.content.includes("EMAIL TOOL")
    );
    expect(emailBlock?.content).toContain("EMAIL TOOL: DISABLED");
    expect(emailBlock?.content).toContain("Settings → Coworker tools");
    expect(inputMessages.some((m) => m.content.includes("EMAIL TOOL: ENABLED"))).toBe(false);
    expect(vi.mocked(getAgentToolStates)).toHaveBeenCalledWith(
      BIZ,
      "dashboard",
      expect.arrayContaining(["send_email"])
    );
  });

  it("injects the ENABLED protocol block (with the EMAIL_SEND sentinels) when the owner enabled the tool", async () => {
    gateStates(true);
    vi.mocked(listMessages).mockResolvedValueOnce([
      { role: "user", content: "earlier" }
    ] as never);
    await POST(jsonRequest({ businessId: BIZ, message: "send an email to bob@x.co" }));
    const { inputMessages, statelessInputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    for (const variant of [inputMessages, statelessInputMessages!]) {
      const emailBlock = variant.find(
        (m) => m.role === "system" && m.content.includes("EMAIL TOOL: ENABLED")
      );
      expect(emailBlock).toBeDefined();
      expect(emailBlock!.content).toContain("<<EMAIL_SEND>>");
      expect(emailBlock!.content).toContain("<<END_EMAIL_SEND>>");
      expect(emailBlock!.content).toContain("Do NOT claim the email was sent");
    }
  });

  /**
   * The invented-recipient regression (nightly e2e, Aug 12 2026).
   *
   * Asked to schedule someone "thru her assistant beth" with NO contact
   * details for Beth, the model emitted an EMAIL_SEND block addressed to
   * `beth@example.com`. That address appears nowhere in the scenario. The
   * only `@example.com` in the whole system prompt was this block's own
   * example line, `{"to": "recipient@example.com", ...}`, so the model
   * filled the name into the placeholder's domain and mailed it.
   *
   * The prose rule "never invent recipients" was already there and did not
   * hold, so the fix is structural: the example must not read as a usable
   * address. These assertions pin the property, not the wording, because
   * the live e2e that caught it only reproduces about half the time.
   */
  it("shows no usable example address the model can fill a name into", async () => {
    gateStates(true);
    await POST(jsonRequest({ businessId: BIZ, message: "email beth" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    const block = inputMessages.find(
      (m) => m.role === "system" && m.content.includes("EMAIL TOOL: ENABLED")
    )!;
    expect(block).toBeDefined();

    // Every address-shaped token in the block must be a bracketed
    // placeholder. A bare `name@domain.tld` is the thing that got copied.
    const addressLike = block.content.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    expect(addressLike, `real-looking addresses in the prompt: ${addressLike}`).toBeNull();

    // And the model is told what to do when it has no address, which is the
    // branch it took wrongly: ask, send nothing.
    expect(block.content).toContain("Never invent a recipient");
    expect(block.content).toContain("include NO block at all");
  });

  it("keeps OWNER_PREAMBLE first, date line second, email block third", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    expect(inputMessages[0].content).toContain("OWNER MODE");
    expect(inputMessages[1].role).toBe("system");
    expect(inputMessages[1].content).toContain("Current date/time:");
    expect(inputMessages[2].role).toBe("system");
    expect(inputMessages[2].content).toContain("EMAIL TOOL");
  });
});

describe("POST /api/dashboard/chat, OWNER_PREAMBLE persona pin", () => {
  it("OWNER_PREAMBLE is the FIRST system message of inputMessages on every call", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    const first = callArgs.inputMessages[0];
    expect(first.role).toBe("system");
    expect(first.content).toContain("OWNER MODE");
    expect(first.content).toContain("You are talking to the business OWNER");
    expect(first.content).toContain("NOT a customer");
  });

  it("[Dashboard] channel marker on the user message, defense in depth alongside OWNER_PREAMBLE", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "what was Joe asking about?" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    const last = callArgs.inputMessages[callArgs.inputMessages.length - 1];
    expect(last).toEqual({ role: "user", content: "[Dashboard] what was Joe asking about?" });
  });

  it("OWNER_PREAMBLE appears on BOTH input variants, pins persona even on the stateless retry path", async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([
      { role: "user", content: "x" }
    ] as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const { inputMessages, statelessInputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    expect(inputMessages[0].content).toContain("OWNER MODE");
    expect(statelessInputMessages?.[0].content).toContain("OWNER MODE");
  });

  it("OWNER_PREAMBLE explicitly authorizes sharing PII (phone numbers) with the owner, defeats invented privacy refusals", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    const preamble = callArgs.inputMessages[0].content;
    expect(preamble).toMatch(/full read access/i);
    expect(preamble).toMatch(/phone numbers/i);
    expect(preamble).toMatch(/private from the owner/i);
  });

  it("OWNER_PREAMBLE carries the Truly-review guardrails: stale-date restatement, header-name authority, honest tool results, proactive tool use", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    const preamble = callArgs.inputMessages[0].content;
    // "tomorrow, July 14" relayed ON July 14, notes' relative dates rot.
    expect(preamble).toContain("DATES IN NOTES MAY BE STALE");
    // Summary's stale full name must not beat the owner-set header name.
    expect(preamble).toContain("CUSTOMER NAMES");
    // "Got it. I've updated the name" when the tool didn't update anything.
    expect(preamble).toContain("TOOL RESULTS ARE THE TRUTH");
    // Generic re-engagement advice instead of offering to draft the text.
    expect(preamble).toContain("BE PROACTIVE WITH TOOLS");
  });

  it("OWNER_PREAMBLE forbids fabricating details", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const callArgs = vi.mocked(insertChatJob).mock.calls[0][0];
    const preamble = callArgs.inputMessages[0].content;
    expect(preamble).toMatch(/no fabrication/i);
    expect(preamble).toContain("/dashboard/calls");
    expect(preamble).toContain("/dashboard/messages");
  });

  it("OWNER_PREAMBLE carries the KYP-review guardrails: channel honesty, AiFlows awareness, owner decisions, exact send bodies", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const preamble = vi.mocked(insertChatJob).mock.calls[0][0].inputMessages[0].content;
    // "can u send problems to my whatsapp?" → "noted" (unsupported channel).
    expect(preamble).toContain("YOUR CHANNELS ARE SMS TEXTING, PHONE CALLS, AND EMAIL");
    expect(preamble).toContain("WhatsApp");
    // "where are the ai flows?" → "I can't access AI flows".
    expect(preamble).toContain("AUTOMATIONS (AIFLOWS)");
    expect(preamble).toContain("/dashboard/aiflows");
    // Owner pasted an advisor checklist → the model answered it FOR him.
    expect(preamble).toContain("THE OWNER'S DECISIONS ARE THEIRS");
    // Resend after "didn't receive anything" texted the model's own previous
    // chat reply ("The text has been sent.") as the SMS body.
    expect(preamble).toContain("resend the SAME intended message");
    expect(preamble).toContain("state the EXACT body that was sent");
  });
});

describe("POST /api/dashboard/chat, connected-integrations status line", () => {
  it("injects the ground-truth line with not-connected arms by default", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "are you connected to calendly?" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    const line = inputMessages.find(
      (m) => m.role === "system" && m.content.includes("CONNECTED INTEGRATIONS")
    );
    expect(line).toBeDefined();
    expect(line!.content).toContain("Calendar: not connected");
    expect(line!.content).toContain("Email mailbox: not connected");
    expect(line!.content).toContain("never guess");
  });

  it("labels the resolved calendar provider (Calendly link-mode caveat) and mailbox on BOTH variants", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValueOnce({
      provider: "calendly",
      providerConfigKey: "calendly-direct",
      connectionId: "c1"
    } as never);
    vi.mocked(resolveEmailConnection).mockResolvedValueOnce({
      provider: "google",
      providerConfigKey: "google-mail",
      connectionId: "e1"
    } as never);
    vi.mocked(listMessages).mockResolvedValueOnce([{ role: "user", content: "x" }] as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const { inputMessages, statelessInputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    for (const variant of [inputMessages, statelessInputMessages!]) {
      const line = variant.find((m) => m.content.includes("CONNECTED INTEGRATIONS"));
      expect(line).toBeDefined();
      expect(line!.content).toContain("Calendly");
      expect(line!.content).toContain("cannot book on their behalf");
      expect(line!.content).toContain("Google mailbox connected");
    }
  });

  it("degrades to NO line (never a failed turn) when the resolvers throw", async () => {
    vi.mocked(resolveCalendarConnection).mockRejectedValueOnce(new Error("nango down"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    expect(inputMessages.some((m) => m.content.includes("CONNECTED INTEGRATIONS"))).toBe(false);
  });
});

describe("POST /api/dashboard/chat, summary preamble", () => {
  it("includes summary_md as a system message when present", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      summary_md: "earlier: discussed pricing tiers"
    } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "and now?" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    const summaryMsg = inputMessages.find(
      (m) => m.role === "system" && m.content.includes("Conversation summary so far")
    );
    expect(summaryMsg?.content).toContain("earlier: discussed pricing tiers");
  });

  it("does NOT include a summary system message when summary_md is whitespace", async () => {
    vi.mocked(getOrCreateActiveThread).mockResolvedValueOnce({
      ...ACTIVE_THREAD,
      summary_md: "   "
    } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    const summaryMsg = inputMessages.find(
      (m) => m.role === "system" && m.content.includes("Conversation summary so far")
    );
    expect(summaryMsg).toBeUndefined();
  });
});

describe("POST /api/dashboard/chat, customer memory preamble (Phase 4)", () => {
  it("does NOT inject a preamble when the business has no customer memories", async () => {
    vi.mocked(listCustomerMemories).mockResolvedValueOnce([]);
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    expect(
      inputMessages.find((m) => m.role === "system" && m.content.includes("recent customers"))
    ).toBeUndefined();
  });

  it("injects the recent-customers preamble when memories exist", async () => {
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
    await POST(jsonRequest({ businessId: BIZ, message: "what was Joe asking about?" }));
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    const customerMsg = inputMessages.find(
      (m) => m.role === "system" && m.content.includes("recent customers")
    );
    expect(customerMsg).toBeDefined();
    expect(customerMsg!.content).toContain("Joe");
    expect(customerMsg!.content).toContain("+15555550123");
  });

  it("succeeds even when the customer memory lookup throws, degraded awareness, not a 500", async () => {
    vi.mocked(listCustomerMemories).mockRejectedValueOnce(new Error("supabase_pgrst_500"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    expect(insertChatJob).toHaveBeenCalledTimes(1);
    const { inputMessages } = vi.mocked(insertChatJob).mock.calls[0][0];
    expect(
      inputMessages.find((m) => m.role === "system" && m.content.includes("recent customers"))
    ).toBeUndefined();
  });
});

describe("POST /api/dashboard/chat, threadId path (continue any thread)", () => {
  it("reactivates an archived thread and uses it as the append + enqueue target", async () => {
    await POST(
      jsonRequest({ businessId: BIZ, threadId: ARCHIVED_THREAD_ID, message: "continue" })
    );
    expect(getThreadById).toHaveBeenCalledWith(ARCHIVED_THREAD_ID);
    expect(reactivateThread).toHaveBeenCalledWith(BIZ, ARCHIVED_THREAD_ID);
    expect(getOrCreateActiveThread).not.toHaveBeenCalled();
    const userAppend = vi.mocked(appendMessage).mock.calls[0];
    expect(userAppend[0]).toBe(ARCHIVED_THREAD_ID);
    expect(userAppend[1]).toBe("user");
    expect(vi.mocked(insertChatJob).mock.calls[0][0].threadId).toBe(ARCHIVED_THREAD_ID);
  });

  it("skips reactivation when the targeted thread is already active (idempotent on repeat sends)", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce(ACTIVE_THREAD as never);
    await POST(
      jsonRequest({ businessId: BIZ, threadId: ACTIVE_THREAD_ID, message: "continue" })
    );
    expect(reactivateThread).not.toHaveBeenCalled();
  });

  it("returns 404 when the thread doesn't exist (caller-supplied UUID is bogus)", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce(null as never);
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: ARCHIVED_THREAD_ID, message: "x" })
    );
    expect(res.status).toBe(404);
    const env = await readEnvelope(res);
    expect(env.error?.code).toBe("NOT_FOUND");
    expect(reactivateThread).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(insertChatJob).not.toHaveBeenCalled();
  });

  it("returns 404 (NOT 403) when the thread belongs to another tenant, anti-IDOR + denies existence side-channel", async () => {
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
    expect(insertChatJob).not.toHaveBeenCalled();
  });

  it("rejects malformed threadId at the schema layer (UUID validation) before any DB read", async () => {
    const res = await POST(
      jsonRequest({ businessId: BIZ, threadId: "not-a-uuid", message: "x" })
    );
    expect(res.status).toBe(400);
    expect(getThreadById).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/chat, legacy path (no threadId)", () => {
  it("uses getOrCreateActiveThread; never touches reactivate", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(getOrCreateActiveThread).toHaveBeenCalledWith(BIZ, "hi");
    expect(getThreadById).not.toHaveBeenCalled();
    expect(reactivateThread).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/chat, pre-flight errors (no enqueue)", () => {
  it("returns 401 on missing auth, Rowboat MUST NOT have been queued", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null as never);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(401);
    expect(insertChatJob).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("returns 409 when the business is paused", async () => {
    supabaseFlagsStub.maybeSingle.mockResolvedValueOnce({
      data: { id: BIZ, is_paused: true, customer_channels_enabled: true },
      error: null
    });
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(409);
    const env = await readEnvelope(res);
    expect(env.error?.message).toMatch(/paused/i);
    expect(insertChatJob).not.toHaveBeenCalled();
  });

  it("returns 429 + 'too many messages' when the rate limiter rejects (preserves the streaming-version status; CONFLICT error code stays for backwards compat)", async () => {
    vi.mocked(rateLimit).mockReturnValueOnce({
      success: false,
      limit: 30,
      remaining: 0,
      reset: 0
    });
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    // 429 is the protocol-correct status (clients/proxies can
    // implement automatic backoff against it). The "CONFLICT"
    // error code string is still emitted in the body so any
    // existing client-side error-code matching keeps working.
    expect(res.status).toBe(429);
    const env = await readEnvelope(res);
    expect(env.error?.code).toBe("CONFLICT");
    expect(env.error?.message).toMatch(/too many/i);
    expect(insertChatJob).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/chat, summarizer fires only after the assistant turn is persisted", () => {
  // Bugbot Medium-severity finding on PR #79: firing the summarizer from
  // the ENQUEUE path would build a summary missing the latest assistant
  // turn (the worker hasn't written it yet), so the worker path's trigger
  // lives on the worker side (POST /api/internal/dashboard-chat-summarize
  // after the assistant insert). The INLINE path persists BOTH turns
  // in-route before its summary check, which preserves the same invariant.
  // This test pins that structure: shouldSummarize is only ever invoked
  // inside finishInlineTurn (after appendMessage(..., "assistant", ...)),
  // never on the enqueue path.
  it("keeps the summary check inside finishInlineTurn, after the assistant insert", async () => {
    const routeSrc = await (
      await import("node:fs/promises")
    ).readFile(
      new URL("../src/app/api/dashboard/chat/route.ts", import.meta.url),
      "utf8"
    );
    const postSection = routeSrc.slice(
      routeSrc.indexOf("export async function POST"),
      routeSrc.indexOf("async function finishInlineTurn")
    );
    expect(postSection).not.toMatch(/shouldSummarize\s*\(/);
    const finishSection = routeSrc.slice(routeSrc.indexOf("async function finishInlineTurn"));
    const assistantInsertAt = finishSection.indexOf('appendMessage(args.thread.id, "assistant"');
    const summaryCheckAt = finishSection.indexOf("shouldSummarize(");
    expect(assistantInsertAt).toBeGreaterThanOrEqual(0);
    expect(summaryCheckAt).toBeGreaterThan(assistantInsertAt);
  });
});

describe("POST /api/dashboard/chat, inline (central Gemini) primary path", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.mocked(runInlineChatTurn).mockResolvedValue({
      ok: true,
      content: "Inline reply",
      drafts: []
    });
    vi.mocked(appendMessage).mockImplementation(
      async (_threadId: string, role: string, content: string) =>
        ({ id: role === "user" ? 99 : 100, role, content, created_at: "now" }) as never
    );
  });

  afterEach(() => {
    delete process.env.GOOGLE_API_KEY;
  });

  it("answers inline (mode=inline, assistant persisted, NO job enqueued) when the key is present and spend is under cap", async () => {
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    expect(res.status).toBe(200);
    const env = await readEnvelope(res);
    expect(env.data).toMatchObject({
      mode: "inline",
      assistantMessageId: 100,
      drafts: []
    });
    expect(env.data?.jobId).toBeUndefined();
    expect(insertChatJob).not.toHaveBeenCalled();
    const assistantAppend = vi.mocked(appendMessage).mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppend?.[2]).toBe("Inline reply");
    // Prompt parity: the inline call received the same system blocks and
    // the [Dashboard]-marked user turn.
    const inlineArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(inlineArgs.systemInstruction).toContain("OWNER MODE");
    expect(inlineArgs.userMessage).toBe("[Dashboard] hi");
    // Knowledge-tool gate: read from Settings (mocked disabled here) and
    // forwarded so the inline turn only declares the tool when allowed.
    expect(vi.mocked(getAgentToolStates)).toHaveBeenCalledWith(
      BIZ,
      "dashboard",
      expect.arrayContaining(["business_knowledge_lookup"])
    );
    expect(inlineArgs.knowledgeToolEnabled).toBe(false);
  });

  it("forwards an enabled knowledge-tool toggle to the inline turn", async () => {
    gateStates(true);
    const res = await POST(jsonRequest({ businessId: BIZ, message: "what's our renewal process?" }));
    expect(res.status).toBe(200);
    const inlineArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(inlineArgs.knowledgeToolEnabled).toBe(true);
  });

  it("reads the generate_image Settings gate and forwards it in the action-tool gates", async () => {
    // Truly Insurance (Jul 16 2026): the inline PRIMARY path never declared
    // the image tool, so a healthy inline turn answered "I don't have an
    // image creation tool" while only worker-fallback turns could generate.
    gateStates(true);
    await POST(jsonRequest({ businessId: BIZ, message: "create an image" }));
    expect(vi.mocked(getAgentToolStates)).toHaveBeenCalledWith(
      BIZ,
      "dashboard",
      expect.arrayContaining(["generate_image"])
    );
    const inlineArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(inlineArgs.actionToolGates).toMatchObject({ generate_image: true });

    vi.mocked(runInlineChatTurn).mockClear();
    gateStates(false);
    await POST(jsonRequest({ businessId: BIZ, message: "create an image" }));
    const disabledArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(disabledArgs.actionToolGates).toMatchObject({ generate_image: false });
  });

  it("newThread archives the active thread first, and only on the threadId-less path", async () => {
    // Fresh-session first send: the companion opens as a new conversation
    // and its first POST carries newThread, so the server archives the old
    // active thread (kept in History) BEFORE minting the new one.
    await POST(jsonRequest({ businessId: BIZ, message: "hi", newThread: true }));
    expect(vi.mocked(deactivateActiveThread)).toHaveBeenCalledWith(BIZ);
    const archived = vi.mocked(deactivateActiveThread).mock.invocationCallOrder[0];
    const minted = vi.mocked(getOrCreateActiveThread).mock.invocationCallOrder[0];
    expect(archived).toBeLessThan(minted);

    // A plain send never archives.
    vi.mocked(deactivateActiveThread).mockClear();
    await POST(jsonRequest({ businessId: BIZ, message: "hi again" }));
    expect(deactivateActiveThread).not.toHaveBeenCalled();

    // Targeting a specific thread wins over newThread: continuing a
    // conversation must never archive a different one as a side effect.
    vi.mocked(getThreadById).mockResolvedValueOnce(ACTIVE_THREAD as never);
    await POST(
      jsonRequest({
        businessId: BIZ,
        message: "continue",
        threadId: ACTIVE_THREAD.id,
        newThread: true
      })
    );
    expect(deactivateActiveThread).not.toHaveBeenCalled();
  });

  it("declares the MCP-bridge tools per role, view-as included", async () => {
    gateStates(true);

    // Owner: full bridge, ladder preamble appended, step headroom raised.
    await POST(jsonRequest({ businessId: BIZ, message: "look at david's texts" }));
    const ownerArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(ownerArgs.maxToolSteps).toBe(6);
    expect(ownerArgs.systemInstruction).toContain("DIRECT BUSINESS TOOLS");
    const ownerNames = (ownerArgs.extraTools?.declarations ?? []).map((d) => d.name);
    expect(ownerNames).toContain("get_sms_thread");
    expect(ownerNames).toContain("update_business_knowledge");
    expect(ownerNames).toContain("set_flow_enabled");

    // Manager: owner-only knowledge editing is NOT declared; the rest is.
    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("manager" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    const managerNames = (
      vi.mocked(runInlineChatTurn).mock.calls[0][0].extraTools?.declarations ?? []
    ).map((d) => d.name);
    expect(managerNames).toContain("get_sms_thread");
    expect(managerNames).toContain("set_flow_enabled");
    expect(managerNames).not.toContain("update_business_knowledge");
    expect(managerNames).not.toContain("get_business_knowledge");

    // Staff: reads and contacts only; flow/agent/settings groups stay off.
    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("staff" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    const staffNames = (
      vi.mocked(runInlineChatTurn).mock.calls[0][0].extraTools?.declarations ?? []
    ).map((d) => d.name);
    expect(staffNames).toContain("search_contacts");
    expect(staffNames).toContain("create_contact");
    expect(staffNames).not.toContain("set_flow_enabled");
    expect(staffNames).not.toContain("update_business_profile");
    expect(staffNames).not.toContain("update_coworker_tool_settings");
    // Reads whose handlers sit at a higher bar are pruned too, not just
    // writes: a staff turn must not burn tool steps on guaranteed refusals
    // (Bugbot Medium on PR #1382).
    expect(staffNames).not.toContain("get_flow");
    expect(staffNames).not.toContain("list_employees");
    expect(staffNames).not.toContain("get_notification_preferences");

    // Admin viewing their OWN business (the HQ tenant): their email resolves
    // the genuine owner role, so the full bridge declares with no
    // view-as-specific handling at all. This is Brian on the HQ tenant.
    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getAuthUser).mockResolvedValueOnce({
      userId: "admin-1",
      email: "owner@example.com",
      isAdmin: true
    } as never);
    await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    const selfOwnedArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(
      (selfOwnedArgs.extraTools?.declarations ?? []).map((d) => d.name)
    ).toContain("update_business_knowledge");
    expect(selfOwnedArgs.systemInstruction).toContain("DIRECT BUSINESS TOOLS");

    // Admin impersonating a FOREIGN tenant, cookie pinned to THIS business:
    // their email holds no role here, so without the view-as resolution the
    // operator would get a strictly smaller toolset than the owner they are
    // standing in for. They resolve owner instead, and the pinned id rides
    // along to the bridge caller so the per-call requireMcpBusinessRole
    // inside each handler agrees (declared-but-refusing tools are worse than
    // none).
    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getAuthUser).mockResolvedValueOnce({
      userId: "admin-1",
      email: "admin@newcoworker.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce(null as never);
    vi.mocked(getViewAsBusinessId).mockResolvedValueOnce(BIZ);
    await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    const viewAsArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect((viewAsArgs.extraTools?.declarations ?? []).map((d) => d.name)).toContain(
      "update_business_knowledge"
    );
    expect(viewAsArgs.systemInstruction).toContain("DIRECT BUSINESS TOOLS");
    expect(viewAsArgs.actionToolGates).toMatchObject({
      update_notification_preferences: true,
      flag_contact_spam: true,
      manage_employee: true
    });

    // Admin whose view-as pin is a DIFFERENT tenant (or absent): no role, no
    // bridge. The grant is scoped to the business they actually asked to act
    // on, not to being admin.
    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getAuthUser).mockResolvedValueOnce({
      userId: "admin-1",
      email: "admin@newcoworker.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce(null as never);
    vi.mocked(getViewAsBusinessId).mockResolvedValueOnce(
      "99999999-9999-4999-8999-999999999999"
    );
    await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    const unpinnedArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(unpinnedArgs.extraTools).toBeNull();
    expect(unpinnedArgs.systemInstruction).not.toContain("DIRECT BUSINESS TOOLS");
    expect(unpinnedArgs.actionToolGates).toMatchObject({
      update_notification_preferences: false,
      flag_contact_spam: false,
      manage_employee: false
    });
  });

  it("declares no bridge tools when every bridge toggle is off", async () => {
    gateStates(false);
    await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    const args = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(args.extraTools).toBeNull();
    expect(args.systemInstruction).not.toContain("DIRECT BUSINESS TOOLS");
  });

  it("gates update_notification_preferences on the caller's manage_settings role, not just the toggle", async () => {
    // A staff-role teammate uses chat freely but must never be handed a
    // settings-mutation tool, manage_settings is manager+ in the policy
    // matrix, matching the notifications settings page.
    gateStates(true);

    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("staff" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "turn on client reply alerts" }));
    const staffArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(staffArgs.actionToolGates).toMatchObject({
      update_notification_preferences: false,
      // Same role bar for the irreversible spam suppression (Bugbot, PR #884):
      // staff must never be handed a STOP-list write.
      flag_contact_spam: false
    });

    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("manager" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "turn on client reply alerts" }));
    const managerArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(managerArgs.actionToolGates).toMatchObject({
      update_notification_preferences: true,
      flag_contact_spam: true
    });

    // A role lookup failure fails CLOSED (no settings tool), never the turn.
    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getBusinessRoleForEmail).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    expect(res.status).toBe(200);
    const failArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(failArgs.actionToolGates).toMatchObject({
      update_notification_preferences: false,
      flag_contact_spam: false
    });
  });

  it("gates edit_aiflow and undo_aiflow_edit on the caller's manage_aiflows role", async () => {
    // Chat access is only operate_messages (staff), and these two rewrite a
    // live automation: the change outlives the turn, since every future run
    // follows the new definition. /api/aiflows/[id] and every bridged MCP
    // flow handler already require manage_aiflows, so without this bar the
    // same capability was reachable at a strictly lower bar through chat.
    gateStates(true);

    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("staff" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "change my lead alert wording" }));
    const staffArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(staffArgs.actionToolGates).toMatchObject({
      edit_aiflow: false,
      undo_aiflow_edit: false,
      // Operating is untouched: running an ENABLED automation the owner
      // already approved is not reconfiguring it.
      list_aiflows: true,
      run_aiflow: true
    });

    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("manager" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "change my lead alert wording" }));
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].actionToolGates).toMatchObject({
      edit_aiflow: true,
      undo_aiflow_edit: true
    });

    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("owner" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "change my lead alert wording" }));
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].actionToolGates).toMatchObject({
      edit_aiflow: true,
      undo_aiflow_edit: true
    });

    // A role lookup failure fails CLOSED, never the turn.
    vi.mocked(runInlineChatTurn).mockClear();
    vi.mocked(getBusinessRoleForEmail).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hello" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].actionToolGates).toMatchObject({
      edit_aiflow: false,
      undo_aiflow_edit: false
    });
  });

  it("keeps the flow-edit tools off when the Settings toggle is off, whatever the role", async () => {
    // Both halves are required: the toggle is the owner's own choice about
    // whether this surface may edit at all, and the role bar is who may use
    // it. A manager must not re-open a tool the owner switched off.
    vi.mocked(getAgentToolStates).mockImplementation(
      async (_biz: string, _agent: string, keys: readonly string[]) =>
        Object.fromEntries(keys.map((k) => [k, k !== "edit_aiflow"]))
    );
    vi.mocked(getBusinessRoleForEmail).mockResolvedValueOnce("owner" as never);
    await POST(jsonRequest({ businessId: BIZ, message: "change my lead alert wording" }));
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].actionToolGates).toMatchObject({
      edit_aiflow: false,
      undo_aiflow_edit: false
    });
  });

  it("returns creation drafts from the inline turn to the client", async () => {
    vi.mocked(runInlineChatTurn).mockResolvedValueOnce({
      ok: true,
      content: "Drafted!",
      drafts: [
        { kind: "agent", name: "Summarizer", instructions: "Summarize.", outputFormat: "markdown" }
      ]
    });
    const res = await POST(jsonRequest({ businessId: BIZ, message: "make an agent" }));
    const env = await readEnvelope(res);
    expect(env.data?.drafts).toEqual([
      { kind: "agent", name: "Summarizer", instructions: "Summarize.", outputFormat: "markdown" }
    ]);
  });

  it("falls back to the worker enqueue when the inline turn fails on a TEXT turn", async () => {
    vi.mocked(runInlineChatTurn).mockResolvedValueOnce({ ok: false, error: "model_failed" });
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const env = await readEnvelope(res);
    expect(env.data).toMatchObject({ mode: "worker", jobId: FAKE_JOB_ID });
    expect(insertChatJob).toHaveBeenCalledTimes(1);
  });

  it("routes to the worker WITHOUT an inline attempt when spend is over the cap", async () => {
    vi.mocked(getChatSpendSnapshotForBusiness).mockResolvedValueOnce({
      periodStart: "2026-07-01T00:00:00.000Z",
      spendMicros: 10_000_000,
      baseCapMicros: 10_000_000,
      creditMicros: 0,
      effectiveCapMicros: 10_000_000
    });
    const res = await POST(jsonRequest({ businessId: BIZ, message: "hi" }));
    const env = await readEnvelope(res);
    expect(env.data).toMatchObject({ mode: "worker" });
    expect(runInlineChatTurn).not.toHaveBeenCalled();
  });

  it("multipart attachment turn: runs inline with the file and marks the stored user message", async () => {
    const form = new FormData();
    form.set("businessId", BIZ);
    form.set("message", "summarize this");
    form.set("file", new File(["a,b\n1,2"], "leads.csv", { type: "text/csv" }));
    const res = await POST(
      new Request("http://localhost/api/dashboard/chat", { method: "POST", body: form })
    );
    expect(res.status).toBe(200);
    const inlineArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(inlineArgs.attachment).toMatchObject({ filename: "leads.csv", mimeType: "text/csv" });
    const userAppend = vi.mocked(appendMessage).mock.calls.find((c) => c[1] === "user");
    expect(userAppend?.[2]).toBe("[Attached: leads.csv] summarize this");
  });

  it("rejects unsupported attachment types before any model work", async () => {
    const form = new FormData();
    form.set("businessId", BIZ);
    form.set("message", "read this");
    form.set("file", new File(["x"], "virus.exe", { type: "application/x-msdownload" }));
    const res = await POST(
      new Request("http://localhost/api/dashboard/chat", { method: "POST", body: form })
    );
    expect(res.status).toBe(400);
    expect(runInlineChatTurn).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("attachment turn over cap: stores an honest refusal reply (mode=inline, no model call, no job)", async () => {
    vi.mocked(getChatSpendSnapshotForBusiness).mockResolvedValueOnce({
      periodStart: "2026-07-01T00:00:00.000Z",
      spendMicros: 20_000_000,
      baseCapMicros: 10_000_000,
      creditMicros: 0,
      effectiveCapMicros: 10_000_000
    });
    const form = new FormData();
    form.set("businessId", BIZ);
    form.set("message", "summarize this");
    form.set("file", new File(["text"], "notes.txt", { type: "text/plain" }));
    const res = await POST(
      new Request("http://localhost/api/dashboard/chat", { method: "POST", body: form })
    );
    const env = await readEnvelope(res);
    expect(env.data).toMatchObject({ mode: "inline" });
    expect(runInlineChatTurn).not.toHaveBeenCalled();
    expect(insertChatJob).not.toHaveBeenCalled();
    const assistantAppend = vi.mocked(appendMessage).mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppend?.[2]).toContain("monthly AI budget is used up");
  });

  it("attachment turn whose inline call fails: stores an honest failure reply instead of enqueueing", async () => {
    vi.mocked(runInlineChatTurn).mockResolvedValueOnce({ ok: false, error: "model_failed" });
    const form = new FormData();
    form.set("businessId", BIZ);
    form.set("message", "summarize this");
    form.set("file", new File(["text"], "notes.txt", { type: "text/plain" }));
    const res = await POST(
      new Request("http://localhost/api/dashboard/chat", { method: "POST", body: form })
    );
    const env = await readEnvelope(res);
    expect(env.data).toMatchObject({ mode: "inline" });
    expect(insertChatJob).not.toHaveBeenCalled();
    const assistantAppend = vi.mocked(appendMessage).mock.calls.find((c) => c[1] === "assistant");
    expect(assistantAppend?.[2]).toContain("couldn't read that attachment");
  });

  it("fires memory capture (fire-and-forget) after a real inline reply", async () => {
    await POST(jsonRequest({ businessId: BIZ, message: "we are closed Sundays" }));
    // Give the void promise a tick to start.
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduleCaptureOwnerRuleInline).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        ownerMessage: "we are closed Sundays",
        assistantReply: "Inline reply"
      })
    );
  });

  it("does NOT fire memory capture for a refusal reply", async () => {
    vi.mocked(getChatSpendSnapshotForBusiness).mockResolvedValueOnce({
      periodStart: "2026-07-01T00:00:00.000Z",
      spendMicros: 20_000_000,
      baseCapMicros: 10_000_000,
      creditMicros: 0,
      effectiveCapMicros: 10_000_000
    });
    const form = new FormData();
    form.set("businessId", BIZ);
    form.set("message", "read this");
    form.set("file", new File(["text"], "notes.txt", { type: "text/plain" }));
    await POST(new Request("http://localhost/api/dashboard/chat", { method: "POST", body: form }));
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduleCaptureOwnerRuleInline).not.toHaveBeenCalled();
  });
});

describe("renderTailTranscript, bounds CPU-only prefill cost", () => {
  it("labels roles as Owner/Coworker/System and preserves chronological order", () => {
    const out = renderTailTranscript([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "system", content: "third" }
    ]);
    expect(out).toBe("[Owner]: first\n\n[Coworker]: second\n\n[System]: third");
  });

  it("truncates a single over-long message to the per-message cap", () => {
    const long = "x".repeat(5000);
    const out = renderTailTranscript([{ role: "assistant", content: long }]);
    expect(out).toContain("… (truncated)");
    // 700-char body + label + ellipsis marker, far below the raw 5000.
    expect(out.length).toBeLessThan(800);
  });

  it("drops oldest messages to respect the total transcript budget, keeping newest", () => {
    // 10 messages of ~700 chars each (post-cap) would be ~7k chars; the
    // 3500-char budget can only fit a few, and the newest must survive.
    const tail = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant" as const,
      content: `msg${i}-${"y".repeat(700)}`
    }));
    const out = renderTailTranscript(tail);
    expect(out.length).toBeLessThanOrEqual(3500 + 720); // budget + one final line slack
    expect(out).toContain("msg9-"); // newest always kept
    expect(out).not.toContain("msg0-"); // oldest dropped
  });

  it("always includes the newest message even if it alone exceeds the budget", () => {
    const huge = "z".repeat(10000);
    const out = renderTailTranscript([{ role: "user", content: huge }]);
    expect(out).toContain("[Owner]:");
    expect(out).toContain("… (truncated)");
  });

  it("returns empty string for an empty tail", () => {
    expect(renderTailTranscript([])).toBe("");
  });

  it("tolerates a missing content field", () => {
    const out = renderTailTranscript([
      { role: "user", content: undefined as unknown as string }
    ]);
    expect(out).toBe("[Owner]: ");
  });
});
