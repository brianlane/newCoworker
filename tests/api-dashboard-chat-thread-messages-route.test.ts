import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/db/dashboard-chat", () => ({
  getThreadById: vi.fn(),
  listMessages: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { GET } from "@/app/api/dashboard/chat/threads/[threadId]/messages/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { getThreadById, listMessages } from "@/lib/db/dashboard-chat";

const BIZ_OWNED = "11111111-1111-4111-8111-111111111111";
const BIZ_OTHER = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";

const THREAD = {
  id: THREAD_ID,
  business_id: BIZ_OWNED,
  rowboat_conversation_id: null,
  rowboat_state: null,
  title: "first chat",
  is_active: false,
  created_at: "2026-04-20T00:00:00Z",
  updated_at: "2026-04-21T00:00:00Z"
};

const MESSAGE_ROWS = [
  {
    id: 1,
    thread_id: THREAD_ID,
    role: "user" as const,
    content: "hi",
    created_at: "2026-04-20T00:00:00Z"
  },
  {
    id: 2,
    thread_id: THREAD_ID,
    role: "assistant" as const,
    content: "hello",
    created_at: "2026-04-20T00:00:01Z"
  }
];

function req(): Request {
  return new Request("http://localhost/api/dashboard/chat/threads/x/messages");
}

function paramsFor(threadId: string) {
  return { params: Promise.resolve({ threadId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "owner@example.com",
    isAdmin: false
  } as never);
  vi.mocked(requireOwner).mockResolvedValue(undefined as never);
  vi.mocked(listMessages).mockResolvedValue(MESSAGE_ROWS as never);
});

describe("GET /api/dashboard/chat/threads/[threadId]/messages", () => {
  it("returns serialized messages for an archived thread the caller owns", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce(THREAD as never);
    const res = await GET(req(), paramsFor(THREAD_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({
      threadId: THREAD_ID,
      title: "first chat",
      isActive: false,
      createdAt: "2026-04-20T00:00:00Z",
      updatedAt: "2026-04-21T00:00:00Z",
      messages: [
        { id: 1, role: "user", content: "hi", createdAt: "2026-04-20T00:00:00Z" },
        { id: 2, role: "assistant", content: "hello", createdAt: "2026-04-20T00:00:01Z" }
      ]
    });
    // Ownership MUST be enforced against the row's business_id, not a
    // caller-supplied query param. This is the IDOR guard.
    expect(requireOwner).toHaveBeenCalledWith(BIZ_OWNED);
    expect(listMessages).toHaveBeenCalledWith(THREAD_ID);
  });

  it("returns 401 for unauthenticated callers and never reads the thread", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null as never);
    const res = await GET(req(), paramsFor(THREAD_ID));
    expect(res.status).toBe(401);
    expect(getThreadById).not.toHaveBeenCalled();
  });

  it("rejects malformed threadId before any DB work", async () => {
    const res = await GET(req(), paramsFor("not-a-uuid"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(getThreadById).not.toHaveBeenCalled();
  });

  it("returns 404 when the thread is unknown — does NOT leak existence via 403", async () => {
    // Returning 403 here would let a caller distinguish 'this thread
    // exists but isn't yours' from 'this thread doesn't exist'. Both
    // collapse to 404 to deny that side-channel.
    vi.mocked(getThreadById).mockResolvedValueOnce(null as never);
    const res = await GET(req(), paramsFor(THREAD_ID));
    expect(res.status).toBe(404);
    expect(requireOwner).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("propagates owner-check rejection when the thread belongs to another tenant", async () => {
    vi.mocked(getThreadById).mockResolvedValueOnce({
      ...THREAD,
      business_id: BIZ_OTHER
    } as never);
    vi.mocked(requireOwner).mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );
    const res = await GET(req(), paramsFor(THREAD_ID));
    expect(res.status).toBe(403);
    // Critically — the ownership check ran against the row's
    // business_id, not anything the caller supplied.
    expect(requireOwner).toHaveBeenCalledWith(BIZ_OTHER);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("admin callers skip requireOwner but still get the messages", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce({
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getThreadById).mockResolvedValueOnce(THREAD as never);
    const res = await GET(req(), paramsFor(THREAD_ID));
    expect(res.status).toBe(200);
    expect(requireOwner).not.toHaveBeenCalled();
    expect(listMessages).toHaveBeenCalledWith(THREAD_ID);
  });

  it("collapses an unexpected DB error into a 500 envelope with no leaked stack", async () => {
    vi.mocked(getThreadById).mockRejectedValueOnce(new Error("connection reset"));
    const res = await GET(req(), paramsFor(THREAD_ID));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.message).not.toContain("connection reset");
  });
});
