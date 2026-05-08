import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/db/dashboard-chat-jobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/dashboard-chat-jobs")>(
    "@/lib/db/dashboard-chat-jobs"
  );
  return {
    ...actual,
    getChatJobById: vi.fn()
  };
});

import { GET } from "@/app/api/dashboard/chat/jobs/[jobId]/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { getChatJobById } from "@/lib/db/dashboard-chat-jobs";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OTHER_BIZ = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const THREAD = "33333333-3333-4333-8333-333333333333";

const FAKE_JOB = {
  id: JOB_ID,
  business_id: BIZ,
  thread_id: THREAD,
  user_message_id: 1,
  status: "processing" as const,
  attempts: 1,
  claimed_by: "worker#42",
  claimed_at: "2026-05-08T16:00:01Z",
  assistant_message_id: null,
  input_messages: [{ role: "user" as const, content: "hi" }],
  stateless_input_messages: null,
  rowboat_conversation_id: "rb-conv",
  error_code: null,
  error_detail: null,
  created_at: "2026-05-08T16:00:00Z",
  started_at: "2026-05-08T16:00:01Z",
  completed_at: null
};

function reqWith(jobId: string): Request {
  return new Request(`http://localhost/api/dashboard/chat/jobs/${jobId}`);
}

function paramsOf(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

async function readEnvelope(res: Response): Promise<{
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}> {
  return JSON.parse(await res.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    email: "owner@example.com",
    isAdmin: false
  } as never);
  vi.mocked(requireOwner).mockResolvedValue(undefined as never);
  vi.mocked(getChatJobById).mockResolvedValue(FAKE_JOB as never);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/dashboard/chat/jobs/[jobId] — polling endpoint", () => {
  it("returns the serialized job status for the owner", async () => {
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    expect(res.status).toBe(200);
    const env = await readEnvelope(res);
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      id: JOB_ID,
      threadId: THREAD,
      status: "processing"
    });
  });

  it("never exposes worker-internal fields (input_messages, stateless_input_messages, attempts, claimed_*) — they contain system preambles the user shouldn't see", async () => {
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    const env = await readEnvelope(res);
    expect(env.data).not.toHaveProperty("input_messages");
    expect(env.data).not.toHaveProperty("stateless_input_messages");
    expect(env.data).not.toHaveProperty("attempts");
    expect(env.data).not.toHaveProperty("claimed_by");
    expect(env.data).not.toHaveProperty("claimed_at");
    expect(env.data).not.toHaveProperty("rowboat_conversation_id");
    expect(env.data).not.toHaveProperty("business_id");
  });

  it("returns 404 when the job doesn't exist (UUID is bogus or already deleted)", async () => {
    vi.mocked(getChatJobById).mockResolvedValueOnce(null as never);
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    expect(res.status).toBe(404);
    const env = await readEnvelope(res);
    expect(env.error?.code).toBe("NOT_FOUND");
  });

  it("returns 401 when not signed in — no row read attempted", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null as never);
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    expect(res.status).toBe(401);
    expect(getChatJobById).not.toHaveBeenCalled();
  });

  it("rejects malformed jobId at the schema layer (UUID validation) before any DB read", async () => {
    const res = await GET(reqWith("not-a-uuid"), paramsOf("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(getChatJobById).not.toHaveBeenCalled();
  });

  it("IDOR: gates ownership against the row's business_id, NEVER a caller-supplied parameter — a stolen jobId can't be read by the owner of a different tenant", async () => {
    vi.mocked(getChatJobById).mockResolvedValueOnce({
      ...FAKE_JOB,
      business_id: OTHER_BIZ
    } as never);
    vi.mocked(requireOwner).mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    expect(res.status).toBe(403);
    // requireOwner was called with the ROW's business_id, not anything
    // from the URL.
    expect(requireOwner).toHaveBeenCalledWith(OTHER_BIZ);
  });

  it("admin users skip requireOwner and can read any tenant's job (audit / debug)", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce({
      email: "admin@example.com",
      isAdmin: true
    } as never);
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    expect(res.status).toBe(200);
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("surfaces error_code + error_detail to the client when the worker reported a failure (so the UI can show the friendly message)", async () => {
    vi.mocked(getChatJobById).mockResolvedValueOnce({
      ...FAKE_JOB,
      status: "error",
      error_code: "rowboat_http_500",
      error_detail: "upstream sad"
    } as never);
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    const env = await readEnvelope(res);
    expect(env.data).toMatchObject({
      status: "error",
      errorCode: "rowboat_http_500",
      errorDetail: "upstream sad"
    });
  });

  it("surfaces assistantMessageId once the worker has marked status='done' — client uses it for the success-path message refresh", async () => {
    vi.mocked(getChatJobById).mockResolvedValueOnce({
      ...FAKE_JOB,
      status: "done",
      assistant_message_id: 99,
      completed_at: "2026-05-08T16:00:05Z"
    } as never);
    const res = await GET(reqWith(JOB_ID), paramsOf(JOB_ID));
    const env = await readEnvelope(res);
    expect(env.data).toMatchObject({
      status: "done",
      assistantMessageId: 99,
      completedAt: "2026-05-08T16:00:05Z"
    });
  });
});
