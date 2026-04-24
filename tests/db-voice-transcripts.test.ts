import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  getTranscriptByCallControlId,
  listTranscriptsForBusiness,
  listTurns,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT
} from "@/lib/db/voice-transcripts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(): Chain {
  const c: Chain = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
    maybeSingle: vi.fn()
  };
  return c;
}

function makeDb(c: Chain) {
  return { from: vi.fn(() => c) };
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const CCI = "cc-abc123";

const TRANSCRIPT = {
  id: "t-1",
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("db/voice-transcripts — listTranscriptsForBusiness", () => {
  it("orders desc by created_at and respects the default limit", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [TRANSCRIPT], error: null });
    const db = makeDb(c);
    await expect(
      listTranscriptsForBusiness(BIZ, {}, db as never)
    ).resolves.toEqual([TRANSCRIPT]);
    expect(db.from).toHaveBeenCalledWith("voice_call_transcripts");
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(DEFAULT_LIST_LIMIT);
  });

  it("clamps callers' requested limit to MAX_LIST_LIMIT", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listTranscriptsForBusiness(BIZ, { limit: 9999 }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(MAX_LIST_LIMIT);
  });

  it("clamps non-positive limits to 1", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listTranscriptsForBusiness(BIZ, { limit: 0 }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(1);
  });

  it("returns an empty array when Supabase returns null data", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: null });
    await expect(
      listTranscriptsForBusiness(BIZ, {}, makeDb(c) as never)
    ).resolves.toEqual([]);
  });

  it("throws on query error", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      listTranscriptsForBusiness(BIZ, {}, makeDb(c) as never)
    ).rejects.toThrow(/listTranscriptsForBusiness: boom/);
  });

  it("falls back to the default service client when none is supplied", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await listTranscriptsForBusiness(BIZ);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("db/voice-transcripts — getTranscriptByCallControlId", () => {
  it("scopes by business_id + call_control_id and returns the row", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: TRANSCRIPT, error: null });
    const db = makeDb(c);
    await expect(
      getTranscriptByCallControlId(BIZ, CCI, db as never)
    ).resolves.toEqual(TRANSCRIPT);
    expect(c.eq).toHaveBeenNthCalledWith(1, "business_id", BIZ);
    expect(c.eq).toHaveBeenNthCalledWith(2, "call_control_id", CCI);
  });

  it("returns null when the transcript is missing", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      getTranscriptByCallControlId(BIZ, CCI, makeDb(c) as never)
    ).resolves.toBeNull();
  });

  it("throws on db error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "bad" } });
    await expect(
      getTranscriptByCallControlId(BIZ, CCI, makeDb(c) as never)
    ).rejects.toThrow(/getTranscriptByCallControlId: bad/);
  });

  it("falls back to the default service client", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await getTranscriptByCallControlId(BIZ, CCI);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("db/voice-transcripts — listTurns", () => {
  it("orders by turn_index ascending", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: [{ id: 1, turn_index: 0 }], error: null });
    const db = makeDb(c);
    const turns = await listTurns("t-1", db as never);
    expect(turns).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("transcript_id", "t-1");
    expect(c.order).toHaveBeenCalledWith("turn_index", { ascending: true });
  });

  it("returns [] when no rows", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: null, error: null });
    await expect(listTurns("t-1", makeDb(c) as never)).resolves.toEqual([]);
  });

  it("throws on query error", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: null, error: { message: "oops" } });
    await expect(listTurns("t-1", makeDb(c) as never)).rejects.toThrow(
      /listTurns: oops/
    );
  });

  it("falls back to the default service client", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await listTurns("t-1");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
