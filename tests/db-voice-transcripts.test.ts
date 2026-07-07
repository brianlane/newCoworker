import { beforeEach, describe, expect, it, vi } from "vitest";

// The residency read-routing layer is unit-tested in tests/residency-read.test.ts
// and the VPS branches of this module in tests/residency-read-flip.test.ts.
// Pin CENTRAL mode here so these tests exercise the Supabase path unchanged.
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false) };
});

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  getTranscriptByCallControlId,
  getTranscriptById,
  listTranscriptsForBusiness,
  listTranscriptsForCaller,
  listTurns,
  listVoiceTurnsForCustomer,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT
} from "@/lib/db/voice-transcripts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(): Chain {
  const c: Chain = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    in: vi.fn(() => c),
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

describe("db/voice-transcripts — getTranscriptById", () => {
  it("scopes by business_id + id (UUID) and returns the row", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: TRANSCRIPT, error: null });
    const db = makeDb(c);
    await expect(
      getTranscriptById(BIZ, TRANSCRIPT.id, db as never)
    ).resolves.toEqual(TRANSCRIPT);
    expect(c.eq).toHaveBeenNthCalledWith(1, "business_id", BIZ);
    expect(c.eq).toHaveBeenNthCalledWith(2, "id", TRANSCRIPT.id);
  });

  it("returns null when the row is missing", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      getTranscriptById(BIZ, TRANSCRIPT.id, makeDb(c) as never)
    ).resolves.toBeNull();
  });

  it("throws on db error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "bad" } });
    await expect(
      getTranscriptById(BIZ, TRANSCRIPT.id, makeDb(c) as never)
    ).rejects.toThrow(/getTranscriptById: bad/);
  });

  it("falls back to the default service client when none is supplied", async () => {
    // Covers the `client ?? (await createSupabaseServiceClient())` short-circuit
    // — without this branch, src/lib/db/voice-transcripts.ts stays at 95% line
    // coverage and the global 100% threshold trips.
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await getTranscriptById(BIZ, TRANSCRIPT.id);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("db/voice-transcripts — listTurns", () => {
  it("orders by turn_index ascending", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: [{ id: 1, turn_index: 0 }], error: null });
    const db = makeDb(c);
    const turns = await listTurns("t-1", {}, db as never);
    expect(turns).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("transcript_id", "t-1");
    expect(c.order).toHaveBeenCalledWith("turn_index", { ascending: true });
  });

  it("returns [] when no rows", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: null, error: null });
    await expect(listTurns("t-1", {}, makeDb(c) as never)).resolves.toEqual([]);
  });

  it("throws on query error", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: null, error: { message: "oops" } });
    await expect(listTurns("t-1", {}, makeDb(c) as never)).rejects.toThrow(
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

describe("db/voice-transcripts — listTranscriptsForCaller (Phase 4b)", () => {
  // Cross-link helper for the per-customer dashboard page. Scopes by
  // caller_e164 (NOT call_control_id / id) and orders by started_at —
  // started_at is more meaningful than created_at on the customers
  // page because it reflects when the conversation actually began.
  const CALLER = "+15555550199";
  const TRANSCRIPT_FOR_CALLER = { ...TRANSCRIPT, caller_e164: CALLER };

  it("scopes by (business_id, caller_e164), orders started_at desc, nullsFirst=false (Phase 4b semantics)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [TRANSCRIPT_FOR_CALLER], error: null });
    const db = makeDb(c);
    await expect(
      listTranscriptsForCaller(BIZ, CALLER, {}, db as never)
    ).resolves.toEqual([TRANSCRIPT_FOR_CALLER]);
    expect(db.from).toHaveBeenCalledWith("voice_call_transcripts");
    expect(c.eq).toHaveBeenNthCalledWith(1, "business_id", BIZ);
    expect(c.in).toHaveBeenCalledWith("caller_e164", [CALLER]);
    expect(c.order).toHaveBeenCalledWith("started_at", {
      ascending: false,
      nullsFirst: false
    });
    expect(c.limit).toHaveBeenCalledWith(DEFAULT_LIST_LIMIT);
  });

  it("includes merged alias numbers (deduped) so calls under any of the profile's numbers appear", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listTranscriptsForCaller(
      BIZ,
      CALLER,
      { aliases: ["+15555550111", CALLER, "+15555550111"] },
      makeDb(c) as never
    );
    expect(c.in).toHaveBeenCalledWith("caller_e164", [CALLER, "+15555550111"]);
  });

  it("clamps requested limits to [1, MAX_LIST_LIMIT]", async () => {
    const c1 = chain();
    c1.limit.mockResolvedValue({ data: [], error: null });
    await listTranscriptsForCaller(BIZ, CALLER, { limit: 99999 }, makeDb(c1) as never);
    expect(c1.limit).toHaveBeenCalledWith(MAX_LIST_LIMIT);

    const c2 = chain();
    c2.limit.mockResolvedValue({ data: [], error: null });
    await listTranscriptsForCaller(BIZ, CALLER, { limit: 0 }, makeDb(c2) as never);
    expect(c2.limit).toHaveBeenCalledWith(1);

    const c3 = chain();
    c3.limit.mockResolvedValue({ data: [], error: null });
    await listTranscriptsForCaller(BIZ, CALLER, { limit: -1 }, makeDb(c3) as never);
    expect(c3.limit).toHaveBeenCalledWith(1);
  });

  it("returns [] when Supabase returns null data", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: null });
    await expect(
      listTranscriptsForCaller(BIZ, CALLER, {}, makeDb(c) as never)
    ).resolves.toEqual([]);
  });

  it("throws on query error", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: { message: "rls" } });
    await expect(
      listTranscriptsForCaller(BIZ, CALLER, {}, makeDb(c) as never)
    ).rejects.toThrow(/listTranscriptsForCaller: rls/);
  });

  it("falls back to the default service client when none is supplied", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await listTranscriptsForCaller(BIZ, CALLER);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("db/voice-transcripts — listVoiceTurnsForCustomer (Phase 2 cross-channel summarizer)", () => {
  const CALLER = "+15555550199";
  const TRANSCRIPT_A = {
    ...TRANSCRIPT,
    id: "t-a",
    caller_e164: CALLER,
    started_at: "2026-04-22T00:00:00Z"
  };
  const TRANSCRIPT_B = {
    ...TRANSCRIPT,
    id: "t-b",
    caller_e164: CALLER,
    started_at: "2026-04-23T00:00:00Z"
  };

  function setupDb(opts: {
    transcripts: typeof TRANSCRIPT[];
    turns?: Array<{
      transcript_id: string;
      role: "caller" | "assistant";
      content: string;
      started_at: string | null;
      turn_index: number;
    }>;
    turnsError?: { message: string };
  }) {
    // listTranscriptsForCaller path uses chain.limit → terminator.
    // The bulk turns SELECT uses chain.in → .order → .limit → terminator.
    const transcriptsChain = chain();
    transcriptsChain.limit.mockResolvedValue({
      data: opts.transcripts,
      error: null
    });
    const turnsChain = chain();
    turnsChain.limit.mockResolvedValue({
      data: opts.turns ?? [],
      error: opts.turnsError ?? null
    });

    let nextCall = 0;
    const db = {
      from: vi.fn((_table: string) => {
        const c = nextCall === 0 ? transcriptsChain : turnsChain;
        nextCall++;
        return c;
      })
    };
    return { db, transcriptsChain, turnsChain };
  }

  it("returns [] when there are no transcripts (early return — no bulk SELECT issued)", async () => {
    const { db } = setupDb({ transcripts: [] });
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result).toEqual([]);
    // Only the transcripts SELECT — no `in()` call when there's
    // nothing to fetch turns for.
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("clamps maxCalls to [1, 25] and maxTurnsTotal to [1, 500]", async () => {
    const { db, transcriptsChain, turnsChain } = setupDb({
      transcripts: [TRANSCRIPT_A]
    });
    await listVoiceTurnsForCustomer(
      BIZ,
      CALLER,
      { maxCalls: 9999, maxTurnsTotal: 999999 },
      db as never
    );
    expect(transcriptsChain.limit).toHaveBeenCalledWith(25);
    expect(turnsChain.limit).toHaveBeenCalledWith(500);

    const second = setupDb({ transcripts: [TRANSCRIPT_A] });
    await listVoiceTurnsForCustomer(
      BIZ,
      CALLER,
      { maxCalls: 0, maxTurnsTotal: -1 },
      second.db as never
    );
    expect(second.transcriptsChain.limit).toHaveBeenCalledWith(1);
    expect(second.turnsChain.limit).toHaveBeenCalledWith(1);
  });

  it("issues ONE bulk SELECT for all transcript ids — never N+1 round-trips on the summarizer hot path", async () => {
    const { db, turnsChain } = setupDb({
      transcripts: [TRANSCRIPT_A, TRANSCRIPT_B],
      turns: [
        {
          transcript_id: "t-a",
          role: "caller",
          content: "first",
          started_at: TRANSCRIPT_A.started_at,
          turn_index: 0
        },
        {
          transcript_id: "t-b",
          role: "assistant",
          content: "second",
          started_at: TRANSCRIPT_B.started_at,
          turn_index: 0
        }
      ]
    });
    await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    // .from("voice_call_transcripts") + .from("voice_call_transcript_turns")
    // — exactly two database round trips regardless of N transcripts.
    expect(db.from).toHaveBeenCalledTimes(2);
    expect(turnsChain.in).toHaveBeenCalledWith("transcript_id", ["t-a", "t-b"]);
  });

  it("returns chronological turns across calls (oldest call first, ascending turn_index within a call)", async () => {
    // Note transcripts come in newest-first (DESC by started_at), but
    // the output should be oldest-first chronologically. The bulk
    // turns SELECT itself orders by turn_index but ACROSS transcripts
    // the chronology has to come from started_at — exercising that
    // sort step.
    const { db } = setupDb({
      transcripts: [TRANSCRIPT_B, TRANSCRIPT_A],
      turns: [
        {
          transcript_id: "t-a",
          role: "caller",
          content: "first call hello",
          started_at: TRANSCRIPT_A.started_at,
          turn_index: 0
        },
        {
          transcript_id: "t-b",
          role: "caller",
          content: "second call hello",
          started_at: TRANSCRIPT_B.started_at,
          turn_index: 0
        }
      ]
    });
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result.map((r) => r.content)).toEqual([
      "first call hello",
      "second call hello"
    ]);
  });

  it("falls back to transcript started_at when the turn row's started_at is null (turn_started_at is best-effort in the bridge)", async () => {
    const { db } = setupDb({
      transcripts: [TRANSCRIPT_A],
      turns: [
        {
          transcript_id: "t-a",
          role: "caller",
          content: "no turn ts",
          started_at: null,
          turn_index: 0
        }
      ]
    });
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result[0]?.callStartedAt).toBe(TRANSCRIPT_A.started_at);
  });

  it("preserves DB ordering (turn_index) when two turns share a callStartedAt — the sort comparator returns 0 (equal-key path)", async () => {
    // Two turns from the same transcript necessarily share the same
    // callStartedAt, so the inter-call sort should be a no-op and
    // turn_index ordering wins. This pins the `return 0;` arm of
    // the comparator; without it, a future refactor that swaps the
    // comparator order would silently misorder turns within a call.
    const { db } = setupDb({
      transcripts: [TRANSCRIPT_A],
      turns: [
        {
          transcript_id: "t-a",
          role: "caller",
          content: "first",
          started_at: TRANSCRIPT_A.started_at,
          turn_index: 0
        },
        {
          transcript_id: "t-a",
          role: "assistant",
          content: "second",
          started_at: TRANSCRIPT_A.started_at,
          turn_index: 1
        }
      ]
    });
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result.map((r) => r.content)).toEqual(["first", "second"]);
  });

  it("orders the LATER call AFTER the earlier one even when transcripts arrive newest-first (covers the `aTs > bTs ⇒ +1` arm)", async () => {
    // The DB returns transcripts newest-first by started_at desc,
    // but the summarizer prompt needs them oldest-first. The sort
    // comparator's "+1" arm rearranges accordingly. Pin both arms
    // (the `-1` arm is covered by the chronological test above; this
    // case explicitly exercises the `aTs > bTs` direction).
    const { db } = setupDb({
      transcripts: [TRANSCRIPT_B, TRANSCRIPT_A],
      turns: [
        // DB ordering (turn_index ascending across IDs): we stage the
        // newer transcript's turn first to force the comparator to
        // swap them.
        {
          transcript_id: "t-b",
          role: "caller",
          content: "newer call",
          started_at: TRANSCRIPT_B.started_at,
          turn_index: 0
        },
        {
          transcript_id: "t-a",
          role: "caller",
          content: "older call",
          started_at: TRANSCRIPT_A.started_at,
          turn_index: 0
        }
      ]
    });
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result.map((r) => r.content)).toEqual(["older call", "newer call"]);
  });

  it("returns null callStartedAt when neither the turn nor the transcript has one (degraded but never crashes the summarizer)", async () => {
    // Defensive: voice_call_transcripts.started_at is NOT NULL in
    // schema, but a Supabase eventual-consistency window or a
    // partial migration could deliver `null` — the summarizer
    // should still produce a result rather than throw on .sort().
    const transcriptNoStarted = { ...TRANSCRIPT_A, started_at: null as unknown as string };
    const { db } = setupDb({
      transcripts: [transcriptNoStarted],
      turns: [
        {
          transcript_id: "t-a",
          role: "caller",
          content: "no ts at all",
          started_at: null,
          turn_index: 0
        }
      ]
    });
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result[0]?.callStartedAt).toBeNull();
  });

  it("propagates errors from the bulk turns SELECT (RLS / planner blowup) — never silently returns []", async () => {
    const { db } = setupDb({
      transcripts: [TRANSCRIPT_A],
      turns: [],
      turnsError: { message: "oom" }
    });
    await expect(
      listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never)
    ).rejects.toThrow(/listVoiceTurnsForCustomer: oom/);
  });

  it("falls back to the default service client when none is supplied", async () => {
    const { db } = setupDb({ transcripts: [] });
    defaultClientSpy.mockReturnValue(db);
    await listVoiceTurnsForCustomer(BIZ, CALLER);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("returns [] when the bulk turns SELECT yields null data (transcripts existed but turns table query returned null — Supabase quirk)", async () => {
    // Pin the `(data as Row[] | null) ?? []` fallback in
    // listVoiceTurnsForCustomer's terminal map. Without it, a
    // null-data response would propagate into `.map` and crash.
    // Built bypassing setupDb's `?? []` default so the actual
    // null-data response reaches the helper.
    const transcriptsChain = chain();
    transcriptsChain.limit.mockResolvedValue({
      data: [TRANSCRIPT_A],
      error: null
    });
    const turnsChain = chain();
    turnsChain.limit.mockResolvedValue({ data: null, error: null });
    let nextCall = 0;
    const db = {
      from: vi.fn(() => {
        const c = nextCall === 0 ? transcriptsChain : turnsChain;
        nextCall++;
        return c;
      })
    };
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result).toEqual([]);
  });

  it("sort comparator's `?? \"\"` fallback fires when BOTH turns lack a callStartedAt — neither in turn nor on the parent transcript", async () => {
    // Two turns with NO timestamp anywhere — exercises the
    // `aTs = a.callStartedAt ?? ""` and matching `bTs ?? ""` arms in
    // the comparator on lines 214-215. Returns `0` (equal-key) so
    // DB ordering wins.
    const transcriptNoStarted = {
      ...TRANSCRIPT_A,
      started_at: null as unknown as string
    };
    const { db } = setupDb({
      transcripts: [transcriptNoStarted],
      turns: [
        {
          transcript_id: "t-a",
          role: "caller",
          content: "first",
          started_at: null,
          turn_index: 0
        },
        {
          transcript_id: "t-a",
          role: "assistant",
          content: "second",
          started_at: null,
          turn_index: 1
        }
      ]
    });
    const result = await listVoiceTurnsForCustomer(BIZ, CALLER, {}, db as never);
    expect(result.map((r) => r.content)).toEqual(["first", "second"]);
    expect(result.every((r) => r.callStartedAt === null)).toBe(true);
  });
});
