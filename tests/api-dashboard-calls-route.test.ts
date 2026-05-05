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
// Route segment is named `callControlId` for backward-compat with the
// directory layout, but the URL value is now a transcript-row UUID —
// see route.ts for why we moved off Telnyx call_control_ids.
const TRANSCRIPT_ID = "33333333-3333-4333-8333-333333333333";
const CCI = "cc-abc123";

const TRANSCRIPT = {
  id: TRANSCRIPT_ID,
  business_id: BIZ,
  call_control_id: CCI,
  reservation_id: null,
  caller_e164: "+15551234567",
  model: "gemini-live",
  status: "completed" as const,
  started_at: "2026-04-23T00:00:00Z",
  ended_at: "2026-04-23T00:03:00Z",
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:03:00Z"
};

function urlFor(transcriptId: string, businessId: string | null = BIZ): string {
  const qs = businessId === null ? "" : `?businessId=${encodeURIComponent(businessId)}`;
  return `http://localhost/api/dashboard/calls/${encodeURIComponent(transcriptId)}${qs}`;
}

function params(transcriptId: string) {
  return { params: Promise.resolve({ callControlId: transcriptId }) };
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

describe("GET /api/dashboard/calls/:callControlId (URL value = transcript UUID)", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(new Request(urlFor(TRANSCRIPT_ID)), params(TRANSCRIPT_ID));
    expect(res.status).toBe(401);
  });

  it("validates the businessId query (400 on missing)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    const res = await GET(new Request(urlFor(TRANSCRIPT_ID, null)), params(TRANSCRIPT_ID));
    expect(res.status).toBe(400);
  });

  it("validates the businessId query (400 on non-uuid)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    const res = await GET(
      new Request(urlFor(TRANSCRIPT_ID, "not-a-uuid")),
      params(TRANSCRIPT_ID)
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-uuid transcript-id segment (defends against routing-mangled `:` from old links)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    // The Zod schema now requires a UUID; an old "v3:zmG1tLVhdK…" link
    // would 400 here instead of crashing the page in the catch-all.
    const res = await GET(
      new Request(urlFor("v3:zmG1tLVhdK")),
      params("v3:zmG1tLVhdK")
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

    await GET(new Request(urlFor(TRANSCRIPT_ID)), params(TRANSCRIPT_ID));
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

    const res = await GET(new Request(urlFor(TRANSCRIPT_ID)), params(TRANSCRIPT_ID));
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

    const res = await GET(new Request(urlFor(TRANSCRIPT_ID)), params(TRANSCRIPT_ID));
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

    const res = await GET(new Request(urlFor(TRANSCRIPT_ID)), params(TRANSCRIPT_ID));
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

    const res = await GET(new Request(urlFor(TRANSCRIPT_ID)), params(TRANSCRIPT_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.transcript.id).toBe(TRANSCRIPT_ID);
    // The response still surfaces `callControlId` for client convenience —
    // it just isn't used as the URL key any more.
    expect(body.data.transcript.callControlId).toBe(CCI);
    expect(body.data.transcript.status).toBe("completed");
    expect(body.data.turns).toHaveLength(2);
    expect(body.data.turns[0].role).toBe("caller");
    expect(body.data.turns[1].role).toBe("assistant");
  });

  it("propagates 500 when db throws", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(requireOwner).mockResolvedValue(undefined as never);
    vi.mocked(getTranscriptById).mockRejectedValue(new Error("boom"));
    const res = await GET(new Request(urlFor(TRANSCRIPT_ID)), params(TRANSCRIPT_ID));
    expect(res.status).toBe(500);
  });
});
