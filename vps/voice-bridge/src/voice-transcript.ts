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
 * the media pipe. Transcripts are best-effort, losing a call's transcript is
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

/**
 * Remove em dashes from OUR OWN transcribed speech before it is persisted.
 *
 * The repo bans em dashes in everything it produces, and every model prompt
 * carries the no-em-dash line. That governs generated text; this is the one
 * surface it cannot reach. `outputTranscription` is Gemini's transcription of
 * its own audio, and the punctuation is chosen by the transcriber, not by the
 * model following our instruction. Chris Bartelot's Aug 3 2026 call has two:
 * "Got that one., And the other place?".
 *
 * Inaudible on the call, visible in the dashboard transcript, so the fix
 * belongs on write rather than in yet another prompt line.
 *
 * A dash is replaced with a space, not deleted, because it usually sits where
 * two transcribed segments were joined ("still here., Were you"); dropping it
 * outright would weld the words together. Runs of whitespace are then
 * collapsed so a dash that already had spaces around it does not leave two.
 *
 * Caller speech is left ALONE: it is a record of what someone else said, and
 * the style rule is about what we write, not about editing a transcript of
 * another person.
 */
export function stripEmDashes(text: string): string {
  return text.replace(/—/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

export type TranscriptDirection = "inbound" | "outbound";

export type TranscriptAdapter = {
  createTranscript: (input: {
    businessId: string;
    callControlId: string;
    callerE164: string;
    model: string;
    direction: TranscriptDirection;
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
  /**
   * Stamp the turn index from which the AI was interpreting between two
   * humans. Optional so an adapter written before translator mode still
   * satisfies the type.
   */
  markInterpretedFrom?: (input: {
    transcriptId: string;
    fromTurnIndex: number;
  }) => Promise<void>;
};

export type TranscriptRecorder = {
  ingest: (message: LiveTranscriptMessage | null | undefined) => Promise<void>;
  finalize: (opts?: { errored?: boolean }) => Promise<void>;
  /**
   * Record that interpreting starts HERE, at the next turn to be written.
   *
   * Everything before this index came from a call with two parties, where the
   * caller role is exact. After it there are three, and the two humans share
   * one undiarized audio stream, so the call view stops attributing those
   * turns to the caller alone.
   */
  markInterpreting: () => Promise<void>;
};

export type TranscriptRecorderInit = {
  businessId: string;
  callControlId: string;
  callerE164: string;
  model: string;
  direction: TranscriptDirection;
};

/**
 * Narrow the Live-API server content frame to the transcription fields we
 * care about. The `@google/genai` types don't yet declare
 * `inputTranscription` / `outputTranscription`, and we don't import from the
 * SDK here (see `LiveTranscriptMessage` above), so we access fields through
 * runtime shape checks.
 *
 * Exported because caller-speech.ts parses the same frames for the translator
 * gate's language judgment. One parser, so the live decision and the stored
 * transcript can never disagree about what the caller said.
 */
export function extractTranscriptionFrame(message: LiveTranscriptMessage): {
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

  // Create the row NOW, not on the first completed turn. Lazy creation meant a
  // call whose only audio was an answering machine's greeting got its row at
  // stream teardown: started_at (a column default) equalled ended_at, so the
  // dashboard showed 0s for a 30-second call, and the AMD handler's mid-call
  // `answering_machine_result` update matched zero rows, silently, because
  // PostgREST reports no error for an update that matches nothing. An answered
  // call with no transcribable speech still gets a row under this contract,
  // which is correct: the call happened.
  void ensureTranscript();

  async function flushTurn(): Promise<void> {
    // Capture AND reserve indices synchronously, before any `await`. If we
    // allocated `turnIndex++` at the insertTurn call sites instead, two
    // concurrent flushes (fire-and-forget ingests for two back-to-back
    // `turnComplete` frames) would interleave at each await boundary and
    // produce caller_A=0, caller_B=1, assistant_A=2, assistant_B=3, the
    // UI sorts by turn_index so the owner would see the conversation in
    // the wrong order. Reserving the slice here locks the ordering to
    // match the synchronous order flushTurn was invoked in, which is the
    // order the turnComplete events arrived.
    const caller = callerBuf.trim();
    const assistant = stripEmDashes(assistantBuf.trim());
    callerBuf = "";
    assistantBuf = "";
    if (!caller && !assistant) return;
    const callerIdx = caller ? turnIndex++ : -1;
    const assistantIdx = assistant ? turnIndex++ : -1;
    const id = await ensureTranscript();
    if (!id) return;
    if (caller) {
      try {
        await adapter.insertTurn({
          transcriptId: id,
          role: "caller",
          content: caller,
          turnIndex: callerIdx
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
          turnIndex: assistantIdx
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

  /**
   * Stamp where interpreting began. Fires ONCE: the model can call
   * transfer_to_owner more than once (it retried three times in ~600ms on the
   * first live translator test), and the first mark is the true boundary.
   *
   * Best-effort like every other write here. Losing the marker costs the call
   * view a label; throwing would take the media pipe down mid-conversation.
   */
  let interpretingMarked = false;
  async function markInterpreting(): Promise<void> {
    if (interpretingMarked) return;
    if (!adapter.markInterpretedFrom) return;
    interpretingMarked = true;
    try {
      const id = await ensureTranscript();
      if (!id) return;
      await adapter.markInterpretedFrom({ transcriptId: id, fromTurnIndex: turnIndex });
    } catch (err) {
      console.error("voice-transcript: markInterpretedFrom", err);
    }
  }

  return { ingest, finalize, markInterpreting };
}
