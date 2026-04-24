/**
 * Per-call transcript accumulator. Fed by Gemini Live `serverContent` frames,
 * flushes one caller row + one assistant row per completed turn, and
 * finalizes the parent transcript row at call teardown.
 *
 * Pure closure: the DB is abstracted behind `TranscriptAdapter` so this can
 * be unit-tested without a live Supabase instance. See `createSupabaseTranscriptAdapter`
 * in `./index.ts` for the production wiring.
 *
 * Resilience: every adapter call is wrapped so a DB failure can never crash
 * the media pipe. Transcripts are best-effort — losing a call's transcript is
 * preferable to hanging up the caller.
 */

// Structural type for the subset of Gemini `LiveServerMessage` fields we
// actually touch. Duck-typed rather than imported from `@google/genai` so the
// root Next.js `tsc --noEmit` (which doesn't resolve the voice-bridge
// subpackage's node_modules) can still type-check callers of this module
// without the root package depending on the Gemini SDK.
export type LiveTranscriptMessage = {
  serverContent?: {
    inputTranscription?: { text?: unknown } | null;
    outputTranscription?: { text?: unknown } | null;
    turnComplete?: unknown;
  } | null;
};

export type TranscriptRole = "caller" | "assistant";

export type TranscriptAdapter = {
  createTranscript: (input: {
    businessId: string;
    callControlId: string;
    callerE164: string;
    model: string;
  }) => Promise<string | null>;
  insertTurn: (input: {
    transcriptId: string;
    role: TranscriptRole;
    content: string;
    turnIndex: number;
  }) => Promise<void>;
  finalizeTranscript: (input: {
    transcriptId: string;
    status: "completed" | "errored";
  }) => Promise<void>;
};

export type TranscriptRecorder = {
  ingest: (message: LiveTranscriptMessage | null | undefined) => Promise<void>;
  finalize: (opts?: { errored?: boolean }) => Promise<void>;
};

export type TranscriptRecorderInit = {
  businessId: string;
  callControlId: string;
  callerE164: string;
  model: string;
};

/**
 * Narrow the Live-API server content frame to the transcription fields we
 * care about. The `@google/genai` types don't yet declare
 * `inputTranscription` / `outputTranscription`, and we don't import from the
 * SDK here (see `LiveTranscriptMessage` above), so we access fields through
 * runtime shape checks.
 */
function extractTranscriptionFrame(message: LiveTranscriptMessage): {
  callerText: string;
  assistantText: string;
  turnComplete: boolean;
} {
  const sc = message.serverContent;
  if (!sc || typeof sc !== "object") {
    return { callerText: "", assistantText: "", turnComplete: false };
  }
  const callerText =
    typeof sc.inputTranscription?.text === "string" ? sc.inputTranscription.text : "";
  const assistantText =
    typeof sc.outputTranscription?.text === "string" ? sc.outputTranscription.text : "";
  return { callerText, assistantText, turnComplete: sc.turnComplete === true };
}

export function createTranscriptRecorder(
  adapter: TranscriptAdapter,
  init: TranscriptRecorderInit
): TranscriptRecorder {
  let transcriptId: string | null = null;
  let createInFlight: Promise<string | null> | null = null;
  let callerBuf = "";
  let assistantBuf = "";
  let turnIndex = 0;
  let finalized = false;
  // Tracks every in-flight `flushTurn` so `finalize` can wait for them to
  // complete before updating the transcript status. Without this, a flush
  // awaiting `createTranscript` can leave `transcriptId` null at the moment
  // finalize checks it, and the row stays 'in_progress' forever.
  const pendingFlushes = new Set<Promise<void>>();

  async function ensureTranscript(): Promise<string | null> {
    if (transcriptId) return transcriptId;
    if (!createInFlight) {
      createInFlight = (async () => {
        try {
          const id = await adapter.createTranscript(init);
          transcriptId = id;
          return id;
        } catch (err) {
          console.error("voice-transcript: createTranscript", err);
          return null;
        }
      })();
    }
    return createInFlight;
  }

  async function flushTurn(): Promise<void> {
    const caller = callerBuf.trim();
    const assistant = assistantBuf.trim();
    callerBuf = "";
    assistantBuf = "";
    if (!caller && !assistant) return;
    const id = await ensureTranscript();
    if (!id) return;
    if (caller) {
      try {
        await adapter.insertTurn({
          transcriptId: id,
          role: "caller",
          content: caller,
          turnIndex: turnIndex++
        });
      } catch (err) {
        console.error("voice-transcript: insertTurn(caller)", err);
      }
    }
    if (assistant) {
      try {
        await adapter.insertTurn({
          transcriptId: id,
          role: "assistant",
          content: assistant,
          turnIndex: turnIndex++
        });
      } catch (err) {
        console.error("voice-transcript: insertTurn(assistant)", err);
      }
    }
  }

  function trackFlush(): Promise<void> {
    const p = flushTurn().finally(() => {
      pendingFlushes.delete(p);
    });
    pendingFlushes.add(p);
    return p;
  }

  async function ingest(message: LiveTranscriptMessage | null | undefined): Promise<void> {
    if (finalized || !message) return;
    const { callerText, assistantText, turnComplete } = extractTranscriptionFrame(message);
    if (callerText) callerBuf += callerText;
    if (assistantText) assistantBuf += assistantText;
    if (turnComplete) {
      await trackFlush();
    }
  }

  async function finalize(opts: { errored?: boolean } = {}): Promise<void> {
    if (finalized) return;
    finalized = true;
    // 1. Flush any trailing partial (caller's last phrase etc.).
    await trackFlush();
    // 2. Drain every in-flight flush. An earlier ingest may have already
    //    consumed the buffers and be awaiting createTranscript / insertTurn;
    //    we must wait for that chain to resolve before touching the row.
    while (pendingFlushes.size > 0) {
      await Promise.allSettled(Array.from(pendingFlushes));
    }
    // 3. Defence in depth: even if all flushes reported "empty buffers" and
    //    skipped ensureTranscript, a prior flush may have left createInFlight
    //    pending. Waiting on it lets transcriptId settle so we don't leak an
    //    'in_progress' row behind a row that was created moments later.
    if (createInFlight) {
      try {
        await createInFlight;
      } catch {
        /* already logged in ensureTranscript */
      }
    }
    if (!transcriptId) return;
    try {
      await adapter.finalizeTranscript({
        transcriptId,
        status: opts.errored ? "errored" : "completed"
      });
    } catch (err) {
      console.error("voice-transcript: finalizeTranscript", err);
    }
  }

  return { ingest, finalize };
}
