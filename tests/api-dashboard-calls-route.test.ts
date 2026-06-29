import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/db/voice-transcripts", () => ({
  getTranscriptById: vi.fn(),
  listTurns: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 }))
}));

import { GET } from "@/app/api/dashboard/calls/[callControlId]/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import {
  getTranscriptById,
  listTurns
} from "@/lib/db/voice-transcripts";
import { rateLimit } from "@/lib/rate-limit";

const BIZ = "11111111-1111-4111-8111-111111111111";
// Route segment is `callControlId` for backward compat, but the URL value
// is now the transcript row UUID — `:` in real call_control_ids breaks
// dynamic-segment routing under Cloudflare/Vercel.
const TRANSCRIPT_ID = "22222222-2222-4222-8222-222222222222";
const CCI = TRANSCRIPT_ID;

const TRANSCRIPT = {
  id: TRANSCRIPT_ID,
  business_id: BIZ,
  call_control_id: "v3:zmG-some-telnyx-id",
  reservation_id: null,
  caller_e164: "+15551234567",
  model: "gemini-live",
  status: "completed" as const,
  direction: "inbound" as const,
  started_at: "2026-04-23T00:00:00Z",
  ended_at: "2026-04-23T00:03:00Z",
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:03:00Z"
};

function urlFor(cci: string, businessId: string | null = BIZ): string {
  const qs = businessId === null ? "" : `?businessId=${encodeURIComponent(businessId)}`;
  return `http://localhost/api/dashboard/calls/${encodeURIComponent(cci)}${qs}`;
}

function params(cci: string) {
  return { params: Promise.resolve({ callControlId: cci }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0
  });
});

describe("GET /api/dashboard/calls/:callControlId", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(new Request(urlFor(CCI)), params(CCI));
    expect(res.status).toBe(401);
  });

  it("validates the businessId query (400 on missing)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    const res = await GET(new Request(urlFor(CCI, null)), params(CCI));
    expect(res.status).toBe(400);
  });

  it("validates the businessId query (400 on non-uuid)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    const res = await GET(
      new Request(urlFor(CCI, "not-a-uuid")),
      params(CCI)
    );
    expect(res.status).toBe(400);
  });

  it("calls requireOwner for non-admin users", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(getTranscriptById).mockResolvedValue(TRANSCRIPT);
    vi.mocked(listTurns).mockResolvedValue([]);

    await GET(new Request(urlFor(CCI)), params(CCI));
    expect(requireOwner).toHaveBeenCalledWith(BIZ);
  });

  it("skips requireOwner for admins", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "admin",
      email: "a@a.com",
      isAdmin: true
    });
    vi.mocked(getTranscriptById).mockResolvedValue(TRANSCRIPT);
    vi.mocked(listTurns).mockResolvedValue([]);

    const res = await GET(new Request(urlFor(CCI)), params(CCI));
    expect(requireOwner).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("returns 429 when the rate limiter rejects", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 60_000
    });

    const res = await GET(new Request(urlFor(CCI)), params(CCI));
    expect(res.status).toBe(429);
  });

  it("returns NOT_FOUND when the transcript does not belong to the caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(getTranscriptById).mockResolvedValue(null);

    const res = await GET(new Request(urlFor(CCI)), params(CCI));
    expect(res.status).toBe(404);
    expect(listTurns).not.toHaveBeenCalled();
  });

  it("returns transcript + turns on the happy path", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(getTranscriptById).mockResolvedValue(TRANSCRIPT);
    vi.mocked(listTurns).mockResolvedValue([
      {
        id: 1,
        transcript_id: TRANSCRIPT_ID,
        role: "caller",
        content: "hi",
        turn_index: 0,
        started_at: null,
        ended_at: null,
        created_at: "2026-04-23T00:00:01Z"
      },
      {
        id: 2,
        transcript_id: TRANSCRIPT_ID,
        role: "assistant",
        content: "hello",
        turn_index: 1,
        started_at: null,
        ended_at: null,
        created_at: "2026-04-23T00:00:02Z"
      }
    ]);

    const res = await GET(new Request(urlFor(CCI)), params(CCI));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.transcript.id).toBe(TRANSCRIPT_ID);
    expect(body.data.transcript.callControlId).toBe("v3:zmG-some-telnyx-id");
    expect(body.data.transcript.status).toBe("completed");
    expect(body.data.turns).toHaveLength(2);
    expect(body.data.turns[0].role).toBe("caller");
    expect(body.data.turns[1].role).toBe("assistant");
  });

  it("validates the transcript-id param shape (non-uuid rejected)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    // Pre-fix code accepted any string up to 128 chars (including raw
    // `v3:…` Telnyx ids that broke dynamic routing). Lock the URL contract
    // down to UUID-shaped values now.
    const res = await GET(new Request(urlFor("v3:not-a-uuid")), params("v3:not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("propagates 500 when db throws", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(getTranscriptById).mockRejectedValue(new Error("boom"));
    const res = await GET(new Request(urlFor(CCI)), params(CCI));
    expect(res.status).toBe(500);
  });
});
