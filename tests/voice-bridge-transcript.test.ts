import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createTranscriptRecorder,
  type LiveTranscriptMessage,
  type TranscriptAdapter
} from "../vps/voice-bridge/src/voice-transcript";

type TurnRow = {
  transcriptId: string;
  role: "caller" | "assistant";
  content: string;
  turnIndex: number;
};

function makeAdapter(overrides: Partial<TranscriptAdapter> = {}): {
  adapter: TranscriptAdapter;
  createCalls: Array<{
    businessId: string;
    callControlId: string;
    callerE164: string;
    model: string;
  }>;
  turns: TurnRow[];
  finalizeCalls: Array<{ transcriptId: string; status: "completed" | "errored" }>;
} {
  const createCalls: Array<{
    businessId: string;
    callControlId: string;
    callerE164: string;
    model: string;
  }> = [];
  const turns: TurnRow[] = [];
  const finalizeCalls: Array<{
    transcriptId: string;
    status: "completed" | "errored";
  }> = [];
  const adapter: TranscriptAdapter = {
    createTranscript: async (input) => {
      createCalls.push(input);
      return "transcript-1";
    },
    insertTurn: async (input) => {
      turns.push(input);
    },
    finalizeTranscript: async (input) => {
      finalizeCalls.push(input);
    },
    ...overrides
  };
  return { adapter, createCalls, turns, finalizeCalls };
}

const INIT = {
  businessId: "biz-1",
  callControlId: "cc-1",
  callerE164: "+15551234567",
  model: "gemini-live"
};

function frame(input: {
  caller?: string;
  assistant?: string;
  turnComplete?: boolean;
}): LiveTranscriptMessage {
  const sc: Record<string, unknown> = {};
  if (input.caller !== undefined) sc.inputTranscription = { text: input.caller };
  if (input.assistant !== undefined) {
    sc.outputTranscription = { text: input.assistant };
  }
  if (input.turnComplete) sc.turnComplete = true;
  return { serverContent: sc } as unknown as LiveTranscriptMessage;
}

let errorSpy: MockInstance<(...args: unknown[]) => void>;
let warnSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("voice-bridge transcript recorder", () => {
  it("concatenates partials and flushes a single turn on turnComplete", async () => {
    const { adapter, turns, createCalls } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);

    await r.ingest(frame({ caller: "Hi, I'm" }));
    await r.ingest(frame({ caller: " Sam." }));
    await r.ingest(frame({ assistant: "Hello Sam," }));
    await r.ingest(frame({ assistant: " how can I help?", turnComplete: true }));

    expect(createCalls).toEqual([INIT]);
    expect(turns).toEqual([
      {
        transcriptId: "transcript-1",
        role: "caller",
        content: "Hi, I'm Sam.",
        turnIndex: 0
      },
      {
        transcriptId: "transcript-1",
        role: "assistant",
        content: "Hello Sam, how can I help?",
        turnIndex: 1
      }
    ]);
  });

  it("increments turnIndex across multiple turns and reuses the transcript row", async () => {
    const { adapter, createCalls, turns } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);

    await r.ingest(frame({ caller: "a", turnComplete: true }));
    await r.ingest(frame({ assistant: "b", turnComplete: true }));
    await r.ingest(frame({ caller: "c", assistant: "d", turnComplete: true }));

    expect(createCalls).toHaveLength(1);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);
    expect(turns.map((t) => t.role)).toEqual([
      "caller",
      "assistant",
      "caller",
      "assistant"
    ]);
  });

  it("does not create a transcript row when the call produced no speech", async () => {
    const { adapter, createCalls, turns, finalizeCalls } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ turnComplete: true }));
    await r.finalize();
    expect(createCalls).toHaveLength(0);
    expect(turns).toHaveLength(0);
    expect(finalizeCalls).toHaveLength(0);
  });

  it("flushes dangling partials on finalize and marks the transcript completed", async () => {
    const { adapter, turns, finalizeCalls } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ caller: "unfinished phrase" }));
    await r.finalize();
    expect(turns).toEqual([
      {
        transcriptId: "transcript-1",
        role: "caller",
        content: "unfinished phrase",
        turnIndex: 0
      }
    ]);
    expect(finalizeCalls).toEqual([
      { transcriptId: "transcript-1", status: "completed" }
    ]);
  });

  it("finalize(errored: true) writes status=errored", async () => {
    const { adapter, finalizeCalls } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ assistant: "boom", turnComplete: true }));
    await r.finalize({ errored: true });
    expect(finalizeCalls).toEqual([
      { transcriptId: "transcript-1", status: "errored" }
    ]);
  });

  it("ignores null/empty messages and non-object serverContent", async () => {
    const { adapter, turns } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(null);
    await r.ingest(undefined);
    await r.ingest({ serverContent: null } as unknown as LiveTranscriptMessage);
    await r.ingest({ serverContent: 42 } as unknown as LiveTranscriptMessage);
    await r.ingest({} as LiveTranscriptMessage);
    expect(turns).toHaveLength(0);
  });

  it("ignores non-string transcription text fields", async () => {
    const { adapter, turns } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);
    const bad = {
      serverContent: {
        inputTranscription: { text: 123 },
        outputTranscription: { text: null },
        turnComplete: true
      }
    } as unknown as LiveTranscriptMessage;
    await r.ingest(bad);
    expect(turns).toHaveLength(0);
  });

  it("is idempotent once finalized — further ingest is a no-op", async () => {
    const { adapter, turns } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ caller: "hi", turnComplete: true }));
    await r.finalize();
    await r.ingest(frame({ caller: "after", turnComplete: true }));
    await r.finalize();
    expect(turns).toHaveLength(1);
  });

  it("skips inserting turns when createTranscript returns null (DB down)", async () => {
    const created: Array<unknown> = [];
    const { adapter, turns, finalizeCalls } = makeAdapter({
      createTranscript: async (input) => {
        created.push(input);
        return null;
      }
    });
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ caller: "anything", turnComplete: true }));
    await r.finalize();
    expect(created).toHaveLength(1);
    expect(turns).toHaveLength(0);
    expect(finalizeCalls).toHaveLength(0);
  });

  it("logs and continues when createTranscript throws", async () => {
    const { adapter, turns } = makeAdapter({
      createTranscript: async () => {
        throw new Error("db unreachable");
      }
    });
    const r = createTranscriptRecorder(adapter, INIT);
    await expect(
      r.ingest(frame({ caller: "x", turnComplete: true }))
    ).resolves.toBeUndefined();
    expect(turns).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "voice-transcript: createTranscript",
      expect.any(Error)
    );
  });

  it("logs and continues when insertTurn throws for caller role", async () => {
    const { adapter } = makeAdapter({
      insertTurn: async (input) => {
        if (input.role === "caller") throw new Error("caller insert failed");
      }
    });
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ caller: "a", assistant: "b", turnComplete: true }));
    expect(errorSpy).toHaveBeenCalledWith(
      "voice-transcript: insertTurn(caller)",
      expect.any(Error)
    );
  });

  it("logs and continues when insertTurn throws for assistant role", async () => {
    const { adapter } = makeAdapter({
      insertTurn: async (input) => {
        if (input.role === "assistant") throw new Error("assistant insert failed");
      }
    });
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ caller: "a", assistant: "b", turnComplete: true }));
    expect(errorSpy).toHaveBeenCalledWith(
      "voice-transcript: insertTurn(assistant)",
      expect.any(Error)
    );
  });

  it("logs and continues when finalizeTranscript throws", async () => {
    const { adapter } = makeAdapter({
      finalizeTranscript: async () => {
        throw new Error("final fail");
      }
    });
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ caller: "x", turnComplete: true }));
    await r.finalize();
    expect(errorSpy).toHaveBeenCalledWith(
      "voice-transcript: finalizeTranscript",
      expect.any(Error)
    );
  });

  it("preserves conversational ordering when two turnComplete frames race", async () => {
    // Regression: turnIndex used to be incremented at each `insertTurn` call,
    // so two concurrent flushes could interleave at each await boundary and
    // produce caller_A=0, caller_B=1, assistant_A=2, assistant_B=3 — wrong,
    // because the UI sorts by turn_index. Indices must now be reserved
    // synchronously at flushTurn entry so order follows ingest order.
    let resolveCreate: ((id: string | null) => void) | null = null;
    const insertCalls: Array<{ turnIndex: number; role: string; content: string }> = [];
    let resolveInsertA: (() => void) | null = null;
    let resolveInsertB: (() => void) | null = null;
    let insertAttempt = 0;
    const adapter: TranscriptAdapter = {
      createTranscript: () =>
        new Promise<string | null>((res) => {
          resolveCreate = res;
        }),
      insertTurn: async (input) => {
        insertCalls.push({
          turnIndex: input.turnIndex,
          role: input.role,
          content: input.content
        });
        // Force each insertTurn to wait a tick so the two flushes interleave
        // between their caller-insert and assistant-insert steps — the exact
        // race described in the bug report.
        insertAttempt += 1;
        if (insertAttempt === 1) {
          await new Promise<void>((res) => {
            resolveInsertA = res;
          });
        } else if (insertAttempt === 2) {
          await new Promise<void>((res) => {
            resolveInsertB = res;
          });
        }
      },
      finalizeTranscript: async () => {}
    };
    const r = createTranscriptRecorder(adapter, INIT);

    const pA = r.ingest(frame({ caller: "A_c", assistant: "A_a", turnComplete: true }));
    const pB = r.ingest(frame({ caller: "B_c", assistant: "B_a", turnComplete: true }));

    // Let createTranscript resolve, then release the inserts in an order
    // that would cause interleaving under the old implementation.
    resolveCreate!("transcript-1");
    await new Promise((res) => setTimeout(res, 0));
    resolveInsertA!();
    await new Promise((res) => setTimeout(res, 0));
    resolveInsertB!();

    await Promise.all([pA, pB]);

    // The DB *insert* order here is [0,2,1,3] — flushB's caller insert fired
    // between flushA's two inserts because we deliberately forced the await
    // interleaving. That's fine: the only thing that matters is that, sorted
    // by turn_index (how the UI renders), we get the correct conversation.
    // Under the old code the indices themselves would have been interleaved
    // (0=caller_A, 1=caller_B, 2=assistant_A, 3=assistant_B), producing a
    // wrong conversational order.
    const sorted = [...insertCalls].sort((a, b) => a.turnIndex - b.turnIndex);
    expect(sorted.map((c) => c.turnIndex)).toEqual([0, 1, 2, 3]);
    expect(sorted.map((c) => `${c.role}:${c.content}`)).toEqual([
      "caller:A_c",
      "assistant:A_a",
      "caller:B_c",
      "assistant:B_a"
    ]);
  });

  it("finalize waits for a pending createTranscript so the row is never stuck in_progress", async () => {
    // Regression: finalize used to check `transcriptId` before awaiting the
    // in-flight createTranscript kicked off by an earlier ingest. When a
    // concurrent finalize raced an ingest whose flushTurn was still awaiting
    // ensureTranscript, the row was created moments after finalize returned
    // and stayed at status='in_progress' forever.
    let resolveCreate: ((id: string | null) => void) | null = null;
    let insertedTurns = 0;
    const finalizeCalls: Array<{ transcriptId: string; status: string }> = [];
    const adapter: TranscriptAdapter = {
      createTranscript: () =>
        new Promise<string | null>((res) => {
          resolveCreate = res;
        }),
      insertTurn: async () => {
        insertedTurns += 1;
      },
      finalizeTranscript: async (input) => {
        finalizeCalls.push(input);
      }
    };
    const r = createTranscriptRecorder(adapter, INIT);
    // Ingest fires (fire-and-forget from onmessage) and starts awaiting
    // createTranscript.
    const ingestPromise = r.ingest(frame({ caller: "hi", turnComplete: true }));
    // Finalize races the ingest before createTranscript resolves.
    const finalizePromise = r.finalize();
    // Now let createTranscript resolve.
    resolveCreate!("late-id");
    await Promise.all([ingestPromise, finalizePromise]);
    expect(insertedTurns).toBe(1);
    expect(finalizeCalls).toEqual([
      { transcriptId: "late-id", status: "completed" }
    ]);
  });

  it("coalesces two concurrent turns into a single createTranscript call", async () => {
    // First `ingest` still has `createTranscript` in-flight when a second
    // `ingest` fires. Both must share the same transcriptId, not double-insert.
    let resolveCreate: ((id: string | null) => void) | null = null;
    let createCount = 0;
    const turns: TurnRow[] = [];
    const adapter: TranscriptAdapter = {
      createTranscript: () => {
        createCount += 1;
        return new Promise<string | null>((res) => {
          resolveCreate = res;
        });
      },
      insertTurn: async (input) => {
        turns.push(input);
      },
      finalizeTranscript: async () => {}
    };
    const r = createTranscriptRecorder(adapter, INIT);
    const p1 = r.ingest(frame({ caller: "a", turnComplete: true }));
    const p2 = r.ingest(frame({ caller: "b", turnComplete: true }));
    resolveCreate!("shared-id");
    await Promise.all([p1, p2]);
    expect(createCount).toBe(1);
    expect(turns.every((t) => t.transcriptId === "shared-id")).toBe(true);
    expect(turns.map((t) => t.content)).toEqual(["a", "b"]);
  });

  // Silence the spy warnings from the previous tests that don't care about
  // the warn channel (this keeps the assertion on warn isolated).
  it("leaves warn channel untouched in the happy path", async () => {
    const { adapter } = makeAdapter();
    const r = createTranscriptRecorder(adapter, INIT);
    await r.ingest(frame({ caller: "hello", turnComplete: true }));
    await r.finalize();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
